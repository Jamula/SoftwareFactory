import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {createServer as createHttpsServer} from 'node:https';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runAspireTelemetry} from '../../tools/engineering-factory/aspire-telemetry-smoke.mjs';
const env={OTEL_EXPORTER_OTLP_ENDPOINT:'https://127.0.0.1:18890',OTEL_EXPORTER_OTLP_PROTOCOL:'http/protobuf',OTEL_EXPORTER_OTLP_HEADERS:'x-otlp-api-key=synthetic'};

function createLoopbackDevCert(){
 const derLen=n=>Buffer.from(n<128?[n]:n<256?[0x81,n]:[0x82,n>>8,n&0xff]);
 const seq=(...items)=>{const b=Buffer.concat(items);return Buffer.concat([Buffer.from([0x30]),derLen(b.length),b]);};
 const set=(...items)=>{const b=Buffer.concat(items);return Buffer.concat([Buffer.from([0x31]),derLen(b.length),b]);};
 const oid=bytes=>Buffer.concat([Buffer.from([0x06,bytes.length]),Buffer.from(bytes)]);
 const ctx=(tag,body)=>Buffer.concat([Buffer.from([0xa0|tag]),derLen(body.length),body]);
 const {privateKey,publicKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const spki=publicKey.export({type:'spki',format:'der'});
 const name=seq(set(seq(oid([0x55,0x04,0x03]),Buffer.from([0x0c,0x09,...Buffer.from('127.0.0.1')]))));
 const alg=seq(oid([0x2a,0x86,0x48,0xce,0x3d,0x04,0x03,0x02]));
 const validity=seq(Buffer.from('170d3235303130313030303030305a','hex'),Buffer.from('170d3335303130313030303030305a','hex'));
 const sanVal=seq(Buffer.from([0x87,0x04,127,0,0,1]));
 const bcVal=seq(Buffer.from([0x01,0x01,0xff]));
 const exts=seq(
  seq(oid([0x55,0x1d,0x13]),Buffer.from([0x01,0x01,0xff]),Buffer.concat([Buffer.from([0x04]),derLen(bcVal.length),bcVal])),
  seq(oid([0x55,0x1d,0x11]),Buffer.concat([Buffer.from([0x04]),derLen(sanVal.length),sanVal]))
 );
 const tbs=seq(ctx(0,Buffer.from([0x02,0x01,0x02])),Buffer.from([0x02,0x08,0x01,...crypto.randomBytes(7)]),alg,name,validity,name,spki,ctx(3,exts));
 const sig=crypto.sign('sha256',tbs,privateKey);
 const certDer=seq(tbs,alg,Buffer.concat([Buffer.from([0x03]),derLen(sig.length+1),Buffer.from([0x00]),sig]));
 return {
  certPem:'-----BEGIN CERTIFICATE-----\n'+certDer.toString('base64').match(/.{1,64}/g).join('\n')+'\n-----END CERTIFICATE-----\n',
  keyPem:privateKey.export({type:'pkcs8',format:'pem'})
 };
}
test('explicit resource runs only after authenticated configuration and flushes the SDK',async()=>{
 const events=[];
 await runAspireTelemetry(env,async config=>{
  assert.deepEqual(config,{endpoint:env.OTEL_EXPORTER_OTLP_ENDPOINT,protocol:env.OTEL_EXPORTER_OTLP_PROTOCOL,headers:env.OTEL_EXPORTER_OTLP_HEADERS});
  return {observe:async(stage,fn)=>{assert.equal(stage,'evaluate');const result=await fn();assert.deepEqual(result,{outcome:'blocked',reason:'POLICY'});events.push('observed');},shutdown:async()=>events.push('shutdown')};
 },async()=>events.push('work'),marker=>events.push(marker));
 assert.deepEqual(events,['work','observed','shutdown','LOCAL_SDK_SHUTDOWN_COMPLETE']);
 await assert.rejects(()=>runAspireTelemetry(null,async()=>assert.fail('unexpected start'),async()=>assert.fail('unexpected work')),/LOCAL_OTLP_CONFIGURATION_REQUIRED/);
 await assert.rejects(()=>runAspireTelemetry({},async()=>assert.fail('unexpected start'),async()=>assert.fail('unexpected work')),/LOCAL_OTLP_CONFIGURATION_REQUIRED/);
 await assert.rejects(()=>runAspireTelemetry(env,async()=>null,async()=>assert.fail('unexpected work')),/LOCAL_OTLP_CONFIGURATION_REQUIRED/);
 const original=Error('fixture failure');
 await assert.rejects(()=>runAspireTelemetry(env,async()=>({observe:async(stage,fn)=>fn(),shutdown:async()=>events.push('cleanup')}),async()=>{throw original;}),e=>e===original);
 assert.equal(events.at(-1),'cleanup');
});
test('default disabled configuration fails without imports',async()=>{
 await assert.rejects(()=>runAspireTelemetry({}),/LOCAL_OTLP_CONFIGURATION_REQUIRED/);
});

test('fail-closed runtime validation rejects per-signal endpoints, proxy overrides and symlink/unreadable CA paths before start',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sf-smoke-ca-'));
 try{
  const realCa=join(dir,'ca.pem'),symlinkCa=join(dir,'symlink.pem');
  writeFileSync(realCa,'-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
  symlinkSync(realCa,symlinkCa);
  for(const badEnv of [
   {...env,OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:'https://remote.invalid'},
   {...env,OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:'https://127.0.0.1:18890/v1/metrics'},
   {...env,NO_PROXY:'*'},
   {...env,HTTPS_PROXY:'http://127.0.0.1:8080'},
   {...env,NODE_USE_ENV_PROXY:'1'},
   {...env,NODE_TLS_REJECT_UNAUTHORIZED:'0'},
   {...env,NODE_EXTRA_CA_CERTS:symlinkCa},
   {...env,NODE_EXTRA_CA_CERTS:join(dir,'missing.pem')}
  ]){
   await assert.rejects(
    ()=>runAspireTelemetry(badEnv,async()=>assert.fail('must not start'),async()=>assert.fail('must not run work')),
    /LOCAL_OTLP_CONFIGURATION_REQUIRED/
   );
  }
 }finally{
  rmSync(dir,{recursive:true,force:true});
 }
});

test('default synthetic work runs through the observer and shuts down',async()=>{
 let observed=false,closed=false;
 await runAspireTelemetry(env,async()=>({observe:async(stage,work)=>{assert.equal(stage,'evaluate');assert.deepEqual(await work(),{outcome:'blocked',reason:'POLICY'});observed=true;},shutdown:async()=>{closed=true;}}));
 assert.equal(observed,true);assert.equal(closed,true);
});

test('end-to-end entrypoint flushes trace, cumulative metrics and correlated log over HTTPS dev-cert before emitting shutdown marker',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sf-smoke-https-'));
 const {certPem,keyPem}=createLoopbackDevCert();
 const certPath=join(dir,'dev-cert.pem');
 writeFileSync(certPath,certPem);
 const received=[];
 const server=createHttpsServer({cert:certPem,key:keyPem},async(req,res)=>{
  const chunks=[];
  for await(const chunk of req)chunks.push(chunk);
  received.push({url:req.url,bytes:Buffer.concat(chunks)});
  res.writeHead(200,{'content-type':'application/x-protobuf'});res.end();
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const markers=[];
 try{
  const localEnv={
   OTEL_EXPORTER_OTLP_ENDPOINT:'https://127.0.0.1:'+server.address().port,
   OTEL_EXPORTER_OTLP_PROTOCOL:'http/protobuf',
   OTEL_EXPORTER_OTLP_HEADERS:'x-otlp-api-key=synthetic',
   NODE_EXTRA_CA_CERTS:certPath
  };
  await runAspireTelemetry(localEnv,undefined,async()=>{},marker=>{
   // All three OTLP signals must already be persisted at the receiver before the marker is emitted.
   assert.deepEqual(['/v1/logs','/v1/metrics','/v1/traces'],[...new Set(received.map(r=>r.url))].sort());
   markers.push(marker);
  });
  assert.deepEqual(markers,['LOCAL_SDK_SHUTDOWN_COMPLETE']);
  // Ambient process.env proxy override still fails closed even when caller passes a subset env object.
  const oldNoProxy=process.env.NO_PROXY;
  process.env.NO_PROXY='*';
  try{
   await assert.rejects(()=>runAspireTelemetry(localEnv,undefined,async()=>assert.fail('must not run')),/LOCAL_OTLP_CONFIGURATION_REQUIRED/);
  }finally{
   if(oldNoProxy===undefined)delete process.env.NO_PROXY;else process.env.NO_PROXY=oldNoProxy;
  }
 }finally{
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
  rmSync(dir,{recursive:true,force:true});
 }
});

test('direct entrypoint refuses missing OTLP configuration',()=>{
 const clean={...process.env};
 delete clean.OTEL_EXPORTER_OTLP_ENDPOINT;delete clean.OTEL_EXPORTER_OTLP_PROTOCOL;delete clean.OTEL_EXPORTER_OTLP_HEADERS;
 const child=spawnSync(process.execPath,['tools/engineering-factory/aspire-telemetry-smoke.mjs'],{env:clean,encoding:'utf8',timeout:5000});
 assert.equal(child.status,1);assert.match(child.stderr,/LOCAL_OTLP_CONFIGURATION_REQUIRED/);
});

test('preserves original workload failure even when shutdown fails; reports cleanup failure after successful work',async()=>{
 const workError=Error('original work error'),shutdownError=Error('cleanup failure');
 let cleanups=0;
 const markers=[];
 const report=marker=>markers.push(marker);
 const start=async()=>({observe:async(stage,fn)=>fn(),shutdown:async()=>{cleanups++;throw shutdownError;}});
 await assert.rejects(()=>runAspireTelemetry(env,start,async()=>{throw workError;},report),error=>error===workError);
 await assert.rejects(()=>runAspireTelemetry(env,start,async()=>{},report),error=>error===shutdownError);
 assert.equal(cleanups,2);
 assert.deepEqual(markers,[]);
});
