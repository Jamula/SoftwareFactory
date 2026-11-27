import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import {mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import https from 'node:https';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  httpsGet,
  pairs,
  parseOrigin,
  readBoundedFile,
  runCli,
  runCliIfDirect,
  verifyDashboardApi
} from '../../tools/engineering-factory/verify-dashboard-api.mjs';

const SCRIPT=resolve('tools/engineering-factory/verify-dashboard-api.mjs');
const FAKE_KEY='A'.repeat(64);
const TRACE='1'.repeat(32);
const SPAN='2'.repeat(16);
const OTHER_SPAN='3'.repeat(16);

const derLen=buf=>buf.length<128?Buffer.from([buf.length]):Buffer.from([0x82,buf.length>>8,buf.length&0xff]);
const tlv=(tag,...parts)=>{const body=Buffer.concat(parts);return Buffer.concat([Buffer.from([tag]),derLen(body),body]);};
const seq=(...parts)=>tlv(0x30,...parts);
const set=(...parts)=>tlv(0x31,...parts);
const oid=bytes=>tlv(0x06,Buffer.from(bytes));

function createEphemeralLoopbackCert(){
  const {privateKey,publicKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const spki=publicKey.export({type:'spki',format:'der'});
  const alg=seq(oid([0x2a,0x86,0x48,0xce,0x3d,0x04,0x03,0x02]));
  const name=seq(set(seq(oid([0x55,0x04,0x03]),tlv(0x0c,Buffer.from('localhost')))));
  const validity=seq(tlv(0x18,Buffer.from('20200101000000Z')),tlv(0x18,Buffer.from('20400101000000Z')));
  const san=seq(
    tlv(0x82,Buffer.from('localhost')),
    tlv(0x87,Buffer.from([127,0,0,1])),
    tlv(0x87,Buffer.from([0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1]))
  );
  const exts=tlv(0xa3,seq(
    seq(oid([0x55,0x1d,0x13]),tlv(0x01,Buffer.from([0xff])),tlv(0x04,seq(tlv(0x01,Buffer.from([0xff]))))),
    seq(oid([0x55,0x1d,0x11]),tlv(0x04,san))
  ));
  const serial=crypto.randomBytes(8);
  serial[0]=(serial[0]&0x7f)|1;
  const tbs=seq(tlv(0xa0,tlv(0x02,Buffer.from([2]))),tlv(0x02,serial),alg,name,validity,name,spki,exts);
  const sig=crypto.sign('sha256',tbs,privateKey);
  const der=seq(tbs,alg,tlv(0x03,Buffer.from([0]),sig));
  const pem='-----BEGIN CERTIFICATE-----\n'+der.toString('base64').match(/.{1,64}/g).join('\n')+'\n-----END CERTIFICATE-----\n';
  return {cert:pem,key:privateKey.export({type:'pkcs8',format:'pem'})};
}

function telemetry(signal,{spanId=SPAN,traceId=TRACE,service='softwarefactory-shadow',scope='softwarefactory'}={}){
  if(signal==='spans'){
    return {
      data:{
        resourceSpans:[{
          resource:{attributes:[{key:'service.name',value:{stringValue:service}}]},
          scopeSpans:[{
            scope:{name:scope},
            spans:[{name:'factory.evaluate',traceId,spanId}]
          }]
        }]
      }
    };
  }
  return {
    data:{
      resourceLogs:[{
        resource:{attributes:[{key:'service.name',value:{stringValue:service}}]},
        scopeLogs:[{
          scope:{name:scope},
          logRecords:[{body:{stringValue:'factory.stage.completed'},traceId,spanId}]
        }]
      }]
    }
  };
}

test('parseOrigin accepts only explicit HTTPS loopback origins with valid ports',()=>{
  assert.deepEqual(parseOrigin('https://127.0.0.1:18888'),{hostname:'127.0.0.1',port:18888});
  assert.deepEqual(parseOrigin('https://localhost:443'),{hostname:'localhost',port:443});
  assert.deepEqual(parseOrigin('https://[::1]:18888'),{hostname:'::1',port:18888});
  for(const bad of [
    undefined,null,'','http://127.0.0.1:18888','https://example.invalid:18888',
    'https://127.0.0.1:18888/path','https://127.0.0.1:18888/','https://user@127.0.0.1:18888',
    'https://127.0.0.1','https://127.0.0.1:0','https://127.0.0.1:70000','https://127.0.0.1:18888?x=1'
  ]){
    assert.throws(()=>parseOrigin(bad),/nonlocal origin/);
  }
});

test('invalid origins, keys, and TLS overrides fail closed before CA read or network access',async()=>{
  const baseEnv={
    FACTORY_DASHBOARD_ORIGIN:'https://127.0.0.1:18888',
    DASHBOARD__API__SECONDARYAPIKEY:FAKE_KEY,
    FACTORY_DASHBOARD_CA:'synthetic-ca.pem'
  };
  let caReads=0,networkCalls=0;
  const guards={
    readCa:()=>{caReads++;throw Error('unexpected CA read');},
    transport:async()=>{networkCalls++;throw Error('unexpected network call');}
  };
  for(const origin of [
    'http://127.0.0.1:18888',
    'https://example.invalid:18888',
    'https://127.0.0.1:18888/path',
    'https://user@127.0.0.1:18888',
    'https://127.0.0.1'
  ]){
    await assert.rejects(()=>verifyDashboardApi({...guards,env:{...baseEnv,FACTORY_DASHBOARD_ORIGIN:origin}}),/nonlocal origin/);
  }
  for(const key of [undefined,'','a'.repeat(64),'G'.repeat(64),'A'.repeat(63),'A'.repeat(65)]){
    await assert.rejects(()=>verifyDashboardApi({...guards,env:{...baseEnv,DASHBOARD__API__SECONDARYAPIKEY:key}}),/invalid ephemeral key/);
  }
  await assert.rejects(()=>verifyDashboardApi({...guards,env:{...baseEnv,NODE_TLS_REJECT_UNAUTHORIZED:'0'}}),/tls verification override/);
  assert.equal(caReads,0);
  assert.equal(networkCalls,0);
});

test('real loopback HTTPS succeeds with explicit scoped CA and rejects untrusted CA',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'factory-api-tls-'));
  const trusted=createEphemeralLoopbackCert();
  const untrusted=createEphemeralLoopbackCert();
  const trustedPath=join(dir,'trusted.pem');
  const untrustedPath=join(dir,'untrusted.pem');
  writeFileSync(trustedPath,trusted.cert);
  writeFileSync(untrustedPath,untrusted.cert);
  const requests=[];
  const server=https.createServer({key:trusted.key,cert:trusted.cert},(req,res)=>{
    const apiKey=req.headers['x-api-key'];
    requests.push({url:req.url,hasKey:Boolean(apiKey),keyMatch:apiKey===FAKE_KEY});
    if(!apiKey){
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(200,{'content-type':'application/json'});
    if(req.url.startsWith('/api/telemetry/spans')){
      res.end(JSON.stringify(telemetry('spans',{traceId:'ABCDEF0123456789abcdef0123456789'})));
      return;
    }
    res.end(JSON.stringify(telemetry('logs',{traceId:'abcdef0123456789ABCDEF0123456789'})));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const {port}=server.address();
  try{
    assert.equal(await verifyDashboardApi({
      env:{
        FACTORY_DASHBOARD_ORIGIN:`https://127.0.0.1:${port}`,
        DASHBOARD__API__SECONDARYAPIKEY:FAKE_KEY,
        FACTORY_DASHBOARD_CA:trustedPath
      }
    }),true);
    assert.deepEqual(requests,[
      {url:'/api/telemetry/spans',hasKey:false,keyMatch:false},
      {url:'/api/telemetry/logs',hasKey:false,keyMatch:false},
      {url:'/api/telemetry/spans?limit=200',hasKey:true,keyMatch:true},
      {url:'/api/telemetry/logs?limit=200',hasKey:true,keyMatch:true}
    ]);
    assert.equal(await verifyDashboardApi({
      env:{
        FACTORY_DASHBOARD_ORIGIN:`https://localhost:${port}`,
        DASHBOARD__API__SECONDARYAPIKEY:FAKE_KEY,
        FACTORY_DASHBOARD_CA:trustedPath
      }
    }),true);
    await assert.rejects(()=>verifyDashboardApi({
      env:{
        FACTORY_DASHBOARD_ORIGIN:`https://127.0.0.1:${port}`,
        DASHBOARD__API__SECONDARYAPIKEY:FAKE_KEY,
        FACTORY_DASHBOARD_CA:untrustedPath
      }
    }));
  }finally{
    server.closeAllConnections();
    await new Promise(r=>server.close(r));
    rmSync(dir,{recursive:true,force:true});
  }
});

test('real HTTPS transport rejects unexpected statuses, redirects, oversized bodies, malformed JSON, and hung responses',async()=>{
  const trusted=createEphemeralLoopbackCert();
  let scenario='ok';
  const server=https.createServer({key:trusted.key,cert:trusted.cert},(req,res)=>{
    const authed=Boolean(req.headers['x-api-key']);
    if(scenario==='unauth-200'){res.writeHead(200);res.end('{}');return;}
    if(scenario==='unauth-302'){res.writeHead(302,{location:'https://example.invalid'});res.end();return;}
    if(scenario==='hang'){return;}
    if(!authed){res.writeHead(401);res.end();return;}
    if(scenario==='auth-500'){res.writeHead(500);res.end();return;}
    if(scenario==='oversized'){
      res.writeHead(200,{'content-type':'application/json'});
      res.end(Buffer.alloc(4_000_001,0x78));
      return;
    }
    if(scenario==='bad-json'){
      res.writeHead(200,{'content-type':'application/json'});
      res.end('{');
      return;
    }
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify(req.url.includes('spans')?telemetry('spans'):telemetry('logs',{spanId:OTHER_SPAN})));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const {port}=server.address();
  const env={
    FACTORY_DASHBOARD_ORIGIN:`https://127.0.0.1:${port}`,
    DASHBOARD__API__SECONDARYAPIKEY:FAKE_KEY,
    FACTORY_DASHBOARD_CA:'unused'
  };
  const run=(mode,timeoutMs=5000)=>{
    scenario=mode;
    return verifyDashboardApi({env,timeoutMs,readCa:()=>Buffer.from(trusted.cert)});
  };
  try{
    await assert.rejects(()=>run('unauth-200'),/unexpected API authentication or response/);
    await assert.rejects(()=>run('unauth-302'),/unexpected API authentication or response/);
    await assert.rejects(()=>run('auth-500'),/unexpected API authentication or response/);
    await assert.rejects(()=>run('oversized'),/oversized response/);
    await assert.rejects(()=>run('bad-json'),SyntaxError);
    await assert.rejects(()=>run('uncorrelated'),/missing correlated telemetry/);
    await assert.rejects(()=>run('hang',80),/dashboard request timeout/);
    const agent=new https.Agent({ca:trusted.cert,keepAlive:false,rejectUnauthorized:true});
    try{
      scenario='ok';
      assert.equal(await httpsGet(agent,'127.0.0.1',port,'/api/telemetry/spans',null,2000),null);
    }finally{
      agent.destroy();
    }
  }finally{
    server.closeAllConnections();
    await new Promise(r=>server.close(r));
  }
});

test('pairs rejects wrong service, scope, zero IDs, extra value fields, and malformed structures',()=>{
  assert.throws(()=>pairs({},'metrics'),/unsupported signal/);
  assert.throws(()=>pairs({},'spans'),/malformed telemetry payload/);
  assert.throws(()=>pairs({data:{resourceSpans:[{resource:{attributes:'bad'}}]}},'spans'),/malformed resource attributes/);
  assert.equal(pairs({data:{resourceSpans:[{}]}},'spans').size,0);
  assert.throws(()=>pairs({data:{resourceSpans:[{resource:{attributes:[{key:'service.name',value:{stringValue:'softwarefactory-shadow'}}]}}]}},'spans'),/malformed telemetry scopes/);
  assert.throws(()=>pairs({data:{resourceSpans:[{resource:{attributes:[{key:'service.name',value:{stringValue:'softwarefactory-shadow'}}]},scopeSpans:[{scope:{name:'softwarefactory'}}]}]}},'spans'),/malformed telemetry rows/);

  assert.equal(pairs(telemetry('spans',{service:'untrusted'}),'spans').size,0);
  assert.equal(pairs(telemetry('spans',{scope:'other'}),'spans').size,0);
  assert.equal(pairs(telemetry('spans',{traceId:'0'.repeat(32)}),'spans').size,0);
  assert.equal(pairs(telemetry('spans',{spanId:'0'.repeat(16)}),'spans').size,0);
  assert.equal(pairs(telemetry('spans',{traceId:'not-hex'}),'spans').size,0);

  const mixedAttrs=telemetry('spans');
  mixedAttrs.data.resourceSpans[0].resource.attributes.unshift(null,{key:'other',value:{stringValue:'x'}});
  mixedAttrs.data.resourceSpans[0].scopeSpans[0].spans.unshift({name:'other.span',traceId:TRACE,spanId:SPAN});
  assert.equal(pairs(mixedAttrs,'spans').size,1);

  const extraField=telemetry('logs');
  extraField.data.resourceLogs[0].scopeLogs[0].logRecords[0].body={stringValue:'factory.stage.completed',intValue:'1'};
  assert.equal(pairs(extraField,'logs').size,0);
});

test('readBoundedFile enforces regular, non-symlink, non-empty, size-bounded files',()=>{
  const dir=mkdtempSync(join(tmpdir(),'factory-bounded-'));
  try{
    assert.throws(()=>readBoundedFile(''),/invalid file path/);
    assert.throws(()=>readBoundedFile(null),/invalid file path/);
    assert.throws(()=>readBoundedFile(dir));
    const empty=join(dir,'empty.pem');
    writeFileSync(empty,'');
    assert.throws(()=>readBoundedFile(empty),/invalid file/);
    const big=join(dir,'big.pem');
    writeFileSync(big,'x'.repeat(16));
    assert.throws(()=>readBoundedFile(big,8),/invalid file/);
    const valid=join(dir,'valid.pem');
    writeFileSync(valid,'cert-bytes');
    assert.equal(readBoundedFile(valid).toString('utf8'),'cert-bytes');
    const link=join(dir,'link.pem');
    try{
      symlinkSync(valid,link);
    }catch{
      symlinkSync(dir,link,'junction');
    }
    assert.throws(()=>readBoundedFile(link));
  }finally{
    rmSync(dir,{recursive:true,force:true});
  }
});

test('CLI entrypoint prints generic failure without echoing synthetic key and handles direct execution',async()=>{
  const out=[],err=[];
  assert.equal(await runCli([],{verify:async()=>true,write:v=>out.push(v),fail:v=>err.push(v)}),0);
  assert.deepEqual(out,['Dashboard stored synthetic trace and correlated structured log']);
  assert.deepEqual(err,[]);

  assert.equal(await runCli(['extra'],{verify:async()=>true,write:v=>out.push(v),fail:v=>err.push(v)}),1);
  assert.deepEqual(err,['Authenticated dashboard API trace/log verification failed']);

  let exitCode;
  assert.equal(await runCliIfDirect('',import.meta.url,[],v=>{exitCode=v;}),false);
  assert.equal(await runCliIfDirect(SCRIPT,pathToFileURL('C:/other.mjs').href,[],v=>{exitCode=v;}),false);
  assert.equal(exitCode,undefined);

  const prevOrigin=process.env.FACTORY_DASHBOARD_ORIGIN;
  process.env.FACTORY_DASHBOARD_ORIGIN='https://remote.example.invalid:18888';
  try{
    assert.equal(await runCliIfDirect(SCRIPT,pathToFileURL(SCRIPT).href,[],v=>{exitCode=v;}),true);
    assert.equal(exitCode,1);
  }finally{
    if(prevOrigin===undefined)delete process.env.FACTORY_DASHBOARD_ORIGIN;
    else process.env.FACTORY_DASHBOARD_ORIGIN=prevOrigin;
  }

  const proc=spawnSync(process.execPath,[SCRIPT],{
    env:{
      ...process.env,
      FACTORY_DASHBOARD_ORIGIN:'https://remote.example.invalid:18888',
      DASHBOARD__API__SECONDARYAPIKEY:FAKE_KEY,
      FACTORY_DASHBOARD_CA:'secret-ca-path.pem'
    },
    encoding:'utf8'
  });
  assert.equal(proc.status,1);
  assert.equal(proc.stdout,'');
  assert.equal(proc.stderr,'Authenticated dashboard API trace/log verification failed\n');
  assert.equal((proc.stdout+proc.stderr).includes(FAKE_KEY),false);
  assert.equal((proc.stdout+proc.stderr).includes('secret-ca-path.pem'),false);
});
