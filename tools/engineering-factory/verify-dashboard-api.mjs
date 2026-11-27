// Runner-only authenticated dashboard readback using an explicitly trusted local CA.
// No root-store mutation, redirect, proxy, or raw telemetry/key output.
import {openSync,fstatSync,lstatSync,readSync,closeSync,constants} from 'node:fs';
import https from 'node:https';
import {pathToFileURL} from 'node:url';

const MAX_BODY_BYTES=4_000_000;
const MAX_CA_BYTES=1_000_000;
const REQUEST_TIMEOUT_MS=5000;
const SAFE_READ_FLAGS=constants.O_RDONLY|(constants.O_NOFOLLOW|0)|(constants.O_NONBLOCK|0);

export function parseOrigin(rawOrigin){
  if(typeof rawOrigin!=='string')throw Error('nonlocal origin');
  const match=/^https:\/\/(localhost|127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/.exec(rawOrigin);
  if(!match)throw Error('nonlocal origin');
  const port=Number(match[2]);
  if(port>65535)throw Error('nonlocal origin');
  const hostname=match[1]==='[::1]'?'::1':match[1];
  return {hostname,port};
}

export function readBoundedFile(filePath,limit=MAX_CA_BYTES,{openFlags=SAFE_READ_FLAGS,statPath=lstatSync}={}){
  if(typeof filePath!=='string'||filePath.length===0)throw Error('invalid file path');
  const fd=openSync(filePath,openFlags);
  try{
    const info=fstatSync(fd);
    const linkInfo=statPath(filePath);
    if(!info.isFile()||linkInfo.isSymbolicLink()||!linkInfo.isFile()||
       info.dev!==linkInfo.dev||info.ino!==linkInfo.ino||info.size===0||info.size>limit)
      throw Error('invalid file');
    const buffer=Buffer.alloc(limit+1);
    let offset=0;
    while(offset<buffer.length){
      const bytes=readSync(fd,buffer,offset,buffer.length-offset,null);
      if(bytes===0)break;
      offset+=bytes;
    }
    if(offset===0||offset>limit)throw Error('invalid file');
    return buffer.subarray(0,offset);
  }finally{
    closeSync(fd);
  }
}

const isExactStringValue=(value,expected)=>
  value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===1&&Object.hasOwn(value,'stringValue')&&value.stringValue===expected;

export function pairs(payload,signal){
  if(signal!=='spans'&&signal!=='logs')throw Error('unsupported signal');
  const groups=payload?.data?.[signal==='spans'?'resourceSpans':'resourceLogs'];
  if(!Array.isArray(groups))throw Error('malformed telemetry payload');
  const result=new Set();
  for(const group of groups){
    const attrs=group?.resource?.attributes;
    if(attrs===undefined)continue;
    if(!Array.isArray(attrs))throw Error('malformed resource attributes');
    if(!attrs.some(a=>a!==null&&typeof a==='object'&&a.key==='service.name'&&isExactStringValue(a.value,'softwarefactory-shadow')))
      continue;
    const scopes=group[signal==='spans'?'scopeSpans':'scopeLogs'];
    if(!Array.isArray(scopes))throw Error('malformed telemetry scopes');
    for(const scope of scopes){
      if(scope?.scope?.name!=='softwarefactory')continue;
      const rows=scope[signal==='spans'?'spans':'logRecords'];
      if(!Array.isArray(rows))throw Error('malformed telemetry rows');
      for(const row of rows){
        if(signal==='spans'&&row?.name!=='factory.evaluate')continue;
        if(signal==='logs'&&!isExactStringValue(row?.body,'factory.stage.completed'))continue;
        const trace=row.traceId,span=row.spanId;
        if(typeof trace==='string'&&typeof span==='string'&&
           /^[0-9a-fA-F]{32}$/.test(trace)&&/^[0-9a-fA-F]{16}$/.test(span)&&
           !/^0+$/.test(trace)&&!/^0+$/.test(span)){
          result.add(`${trace.toLowerCase()}:${span.toLowerCase()}`);
        }
      }
    }
  }
  return result;
}

export function httpsGet(agent,hostname,port,path,key,timeoutMs){
  return new Promise((resolve,reject)=>{
    let settled=false;
    const fail=error=>{if(!settled){settled=true;clearTimeout(timer);reject(error);}};
    const req=https.request({
      hostname,
      port,
      path,
      method:'GET',
      agent,
      rejectUnauthorized:true,
      headers:key===null?{}:{'X-API-Key':key}
    },res=>{
      const expected=key===null?401:200;
      if(res.statusCode!==expected){
        res.resume();
        req.destroy();
        fail(Error('unexpected API authentication or response'));
        return;
      }
      const chunks=[];
      let total=0;
      res.on('data',chunk=>{
        total+=chunk.length;
        if(total>MAX_BODY_BYTES){
          req.destroy();
          fail(Error('oversized response'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error',fail);
      res.on('end',()=>{
        if(settled)return;
        clearTimeout(timer);
        if(key===null){
          settled=true;
          resolve(null);
          return;
        }
        try{
          const parsed=JSON.parse(Buffer.concat(chunks,total).toString('utf8'));
          settled=true;
          resolve(parsed);
        }catch(error){
          settled=true;
          reject(error);
        }
      });
    });
    const timer=setTimeout(()=>req.destroy(Error('dashboard request timeout')),timeoutMs);
    req.on('error',fail);
    req.end();
  });
}

export async function verifyDashboardApi({
  env=process.env,
  timeoutMs=REQUEST_TIMEOUT_MS,
  readCa=readBoundedFile,
  transport=httpsGet
}={}){
  const {hostname,port}=parseOrigin(env.FACTORY_DASHBOARD_ORIGIN);
  const key=env.DASHBOARD__API__SECONDARYAPIKEY;
  if(typeof key!=='string'||!/^[0-9A-F]{64}$/.test(key))throw Error('invalid ephemeral key');
  if(env.NODE_TLS_REJECT_UNAUTHORIZED)throw Error('tls verification override');
  const ca=readCa(env.FACTORY_DASHBOARD_CA);
  const agent=new https.Agent({ca,keepAlive:false,maxSockets:1,rejectUnauthorized:true});
  try{
    await transport(agent,hostname,port,'/api/telemetry/spans',null,timeoutMs);
    await transport(agent,hostname,port,'/api/telemetry/logs',null,timeoutMs);
    const spans=pairs(await transport(agent,hostname,port,'/api/telemetry/spans?limit=200',key,timeoutMs),'spans');
    const logs=pairs(await transport(agent,hostname,port,'/api/telemetry/logs?limit=200',key,timeoutMs),'logs');
    if(![...spans].some(id=>logs.has(id)))throw Error('missing correlated telemetry');
    return true;
  }finally{
    agent.destroy();
  }
}

export async function runCli(args,{verify=verifyDashboardApi,write=console.log,fail=console.error}={}){
  try{
    if(args.length!==0)throw Error('unexpected arguments');
    await verify();
    write('Dashboard stored synthetic trace and correlated structured log');
    return 0;
  }catch{
    fail('Authenticated dashboard API trace/log verification failed');
    return 1;
  }
}

export async function runCliIfDirect(entrypoint,moduleUrl,args,setExitCode=value=>{process.exitCode=value;}){
  if(entrypoint&&pathToFileURL(entrypoint).href===moduleUrl){
    setExitCode(await runCli(args));
    return true;
  }
  return false;
}

await runCliIfDirect(process.argv[1],import.meta.url,process.argv.slice(2));
