import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import {chmodSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startLocalSdk,validateLocalOtlpEnvironment} from '../../tools/engineering-factory/local-otel-sdk.mjs';
const configuration={endpoint:'http://127.0.0.1:4318',protocol:'http/protobuf',headers:'x-otlp-api-key=synthetic'};

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

test('disabled or invalid local SDK never imports dependencies',async()=>{
 let calls=0;
 const load=async()=>{calls++;throw Error('must not load');};
 for(const config of [null,{},{...configuration,endpoint:'https://remote.example:4318'},{...configuration,protocol:'grpc'},{...configuration,headers:''}])
  assert.equal(await startLocalSdk(config,load),null);
 assert.equal(validateLocalOtlpEnvironment(configuration,null),null);
 assert.ok(validateLocalOtlpEnvironment(configuration));
 assert.equal(calls,0);
});
test('explicit private providers, deterministic forceFlush before shutdown, and post-shutdown observe rejection',async()=>{
 const opts=[],events=[],configs=[];
 class Exporter{constructor(options){opts.push(options);}}
 class Processor{constructor({exporter}){assert.ok(exporter instanceof Exporter);this.exporter=exporter;}}
 class Reader{constructor(options){this.options=options;}}
 class Provider{constructor(options){configs.push(options);}async shutdown(options){assert.deepEqual(options,{timeoutMillis:3000});events.push('shutdown');}}
 class TracerProvider extends Provider{
  async forceFlush(options){assert.deepEqual(options,{timeoutMillis:3000});events.push('flush:trace');}
  getTracer(){return {startSpan:(name,options,parent)=>({end(){},name,parent})};}
 }
 class MeterProvider extends Provider{
  async forceFlush(options){assert.deepEqual(options,{timeoutMillis:3000});events.push('flush:metric');}
  getMeter(){return {createCounter:()=>({add(){}}),createHistogram:()=>({record(){}})};}
 }
 // Exercise mixed support: LoggerProvider omits forceFlush while TracerProvider and MeterProvider implement it.
 class LoggerProvider extends Provider{getLogger(){return {emit:r=>events.push(r)};}}
 const root={root:true};
 const api={TracerProvider:TracerProvider,MeterProvider,LoggerProvider,ROOT_CONTEXT:root,
  resourceFromAttributes:a=>a,SimpleSpanProcessor:Processor,SimpleLogRecordProcessor:Processor,PeriodicExportingMetricReader:Reader,
  OTLPTraceExporter:Exporter,OTLPMetricExporter:Exporter,OTLPLogExporter:Exporter,
  trace:{setSpan:(parent,span)=>({parent,span}),getTracer(){assert.fail('global tracer');}},
  metrics:{getMeter(){assert.fail('global meter');}},logs:{getLogger(){assert.fail('global logger');}}
 };
 const oldCa=process.env.NODE_EXTRA_CA_CERTS;
 delete process.env.NODE_EXTRA_CA_CERTS;
 let sdk;
 try{
  sdk=await startLocalSdk(configuration,async()=>api);
  assert.deepEqual(opts.map(({httpAgentOptions,...rest})=>rest),['traces','metrics','logs'].map(s=>({url:'http://127.0.0.1:4318/v1/'+s,headers:{'x-otlp-api-key':'synthetic'},timeoutMillis:3000})));
  for(const options of opts){
   for(const protocol of ['http:','https:']){
    const agent=await options.httpAgentOptions(protocol);
    try{assert.equal(agent.protocol,protocol);assert.equal(agent.options.keepAlive,false);assert.equal(agent.options.rejectUnauthorized,true);assert.equal(agent.options.ca,undefined);}
    finally{agent.destroy();}
   }
  }
 }finally{
  if(oldCa===undefined)delete process.env.NODE_EXTRA_CA_CERTS;else process.env.NODE_EXTRA_CA_CERTS=oldCa;
 }
 assert.ok(configs.every(c=>c.resource['service.name']==='softwarefactory-shadow'));
 assert.equal(configs[1].readers[0].options.exportIntervalMillis,3000);
 assert.ok(configs[1].readers[0].options.exportIntervalMillis>=configs[1].readers[0].options.exportTimeoutMillis);
 assert.deepEqual(await sdk.observe('evaluate',async()=>({outcome:'blocked',reason:'POLICY'})),{outcome:'blocked',reason:'POLICY'});
 assert.equal(events[0].body,'factory.stage.completed');
 assert.equal(events[0].context.span.name,'factory.evaluate');
 let release;
 const gate=new Promise(resolve=>{release=resolve;});
 const accepted=sdk.observe('evaluate',async()=>{
  await gate;
  assert.throws(()=>sdk.observe('evaluate',()=>assert.fail('nested after stop')),/LOCAL_SDK_STOPPED/);
  return {outcome:'blocked',reason:'POLICY'};
 });
 const rejected=sdk.observe('evaluate',async()=>{throw Error('work failure');});
 const rejection=assert.rejects(rejected,/work failure/);
 const done=sdk.shutdown();assert.equal(sdk.shutdown(),done);
 assert.throws(()=>sdk.observe('evaluate',()=>assert.fail('stopped')),/LOCAL_SDK_STOPPED/);
 await rejection;assert.equal(events.includes('shutdown'),false);
 release();await accepted;await done;
 const flushEnd=Math.max(events.indexOf('flush:trace'),events.indexOf('flush:metric'));
 const firstShutdown=events.indexOf('shutdown');
 assert.ok(events.includes('flush:trace')&&events.includes('flush:metric'));
 assert.ok(flushEnd<firstShutdown,'all forceFlush calls must finish before any provider shutdown');
 assert.equal(events.filter(x=>x==='shutdown').length,3);
 assert.throws(()=>sdk.observe('evaluate',()=>assert.fail('stopped')),/LOCAL_SDK_STOPPED/);
});
test('startup and dependency failure cannot manufacture SDK readiness',async()=>{
 const error=Error('unavailable');
 await assert.rejects(()=>startLocalSdk(configuration,async()=>{throw error;}),e=>e===error);
});

test('untrusted exporter, proxy, NO_PROXY and NODE_OPTIONS overrides fail before SDK loading',async()=>{
 for(const [key,value] of [
  ['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT','https://remote.invalid'],
  ['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT','http://127.0.0.1:4318/v1/traces'],
  ['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT','http://127.0.0.1:4318/v1/metrics'],
  ['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT','http://127.0.0.1:4318/v1/logs'],
  ['OTEL_EXPORTER_OTLP_TRACES_HEADERS','x-otlp-api-key=synthetic'],
  ['OTEL_EXPORTER_OTLP_CERTIFICATE','/tmp/cert.pem'],
  ['OTEL_EXPORTER_OTLP_ENDPOINT','http://127.0.0.1:9999'],
  ['OTEL_EXPORTER_OTLP_PROTOCOL','grpc'],
  ['OTEL_TRACES_EXPORTER','console'],
  ['OTEL_METRICS_EXPORTER','none'],
  ['OTEL_LOGS_EXPORTER','otlp'],
  ['NO_PROXY','*'],
  ['no_proxy','127.0.0.1'],
  ['HTTP_PROXY','http://127.0.0.1:8080'],
  ['HTTPS_PROXY','http://127.0.0.1:8080'],
  ['ALL_PROXY','socks5://127.0.0.1:1080'],
  ['NODE_USE_ENV_PROXY','1'],
  ['NODE_OPTIONS','--use-openssl-ca --use-env-proxy']
 ]){
  const old=process.env[key];
  process.env[key]=value;
  try {assert.equal(await startLocalSdk(configuration,async()=>assert.fail('must not load')),null);}
  finally {if(old===undefined)delete process.env[key];else process.env[key]=old;}
 }
 // Allowed Aspire runtime env settings remain accepted.
 assert.ok(validateLocalOtlpEnvironment(configuration,{
  OTEL_SDK_DISABLED:'false',
  OTEL_EXPORTER_OTLP_ENDPOINT:configuration.endpoint,
  OTEL_EXPORTER_OTLP_PROTOCOL:configuration.protocol,
  OTEL_EXPORTER_OTLP_HEADERS:configuration.headers,
  OTEL_SERVICE_NAME:'synthetic-shadow',
  NODE_OPTIONS:'--use-openssl-ca',
  NO_PROXY:undefined
 }));
});

test('NODE_EXTRA_CA_CERTS rejects symlinks, unreadable, empty, oversized or malformed/truncated PEM paths while accepting valid bundles',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sf-ca-test-'));
 try{
  const {certPem,keyPem}=createLoopbackDevCert();
  const {certPem:secondCertPem}=createLoopbackDevCert();
  const validPath=join(dir,'valid.pem');
  writeFileSync(validPath,certPem);
  const bundlePath=join(dir,'bundle.pem');
  writeFileSync(bundlePath,certPem.replace(/\n/g,'\r\n')+'\r\n'+secondCertPem);
  const linkPath=join(dir,'symlink.pem');
  symlinkSync(validPath,linkPath);
  const emptyPath=join(dir,'empty.pem');
  writeFileSync(emptyPath,'');
  const hugePath=join(dir,'huge.pem');
  writeFileSync(hugePath,'a'.repeat(1048577));
  const nonPemPath=join(dir,'invalid.txt');
  writeFileSync(nonPemPath,'not-a-certificate');
  const headerOnlyPath=join(dir,'header-only.pem');
  writeFileSync(headerOnlyPath,'-----BEGIN CERTIFICATE-----\n');
  const truncatedCertPath=join(dir,'truncated.pem');
  writeFileSync(truncatedCertPath,'-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
  const trailingGarbagePath=join(dir,'trailing.pem');
  writeFileSync(trailingGarbagePath,certPem+'\n-----BEGIN CERTIFICATE-----\nMIIB');
  const mixedKeyPath=join(dir,'mixed-key.pem');
  writeFileSync(mixedKeyPath,certPem+'\n'+keyPem);
  const unreadablePath=join(dir,'unreadable.pem');
  writeFileSync(unreadablePath,certPem);
  chmodSync(unreadablePath,0o000);
  const badPaths=['', '   ', validPath+'\0extra', join(dir,'missing.pem'), linkPath, dir, emptyPath, hugePath, nonPemPath, headerOnlyPath, truncatedCertPath, trailingGarbagePath, mixedKeyPath, unreadablePath];
  if(process.platform!=='win32'){
   const fifoPath=join(dir,'unopened.fifo');
   execFileSync('mkfifo',[fifoPath]);
   badPaths.push(fifoPath);
  }
  try{
   for(const bad of badPaths){
    assert.equal(validateLocalOtlpEnvironment(configuration,{NODE_EXTRA_CA_CERTS:bad}),null);
   }
   assert.equal(validateLocalOtlpEnvironment(configuration,{NODE_EXTRA_CA_CERTS:123}),null);
   assert.equal(validateLocalOtlpEnvironment(configuration,{NODE_EXTRA_CA_CERTS:validPath,node_extra_ca_certs:validPath}),null);
   assert.ok(validateLocalOtlpEnvironment(configuration,{NODE_EXTRA_CA_CERTS:validPath}));
   assert.ok(validateLocalOtlpEnvironment(configuration,{NODE_EXTRA_CA_CERTS:bundlePath}));
   const old=process.env.NODE_EXTRA_CA_CERTS;
   process.env.NODE_EXTRA_CA_CERTS=linkPath;
   try{assert.equal(await startLocalSdk(configuration,async()=>assert.fail('must not load')),null);}
   finally{if(old===undefined)delete process.env.NODE_EXTRA_CA_CERTS;else process.env.NODE_EXTRA_CA_CERTS=old;}
  }finally{
   chmodSync(unreadablePath,0o600);
  }
 }finally{
  rmSync(dir,{recursive:true,force:true});
 }
});

function assertMetricTimestampsMonotonic(metricPacket){
 let points=0;
 for(let j=0;j+18<=metricPacket.length;j++){
  if(metricPacket[j]===0x11&&metricPacket[j+9]===0x19){
   const start=metricPacket.readBigUInt64LE(j+1),end=metricPacket.readBigUInt64LE(j+10);
   if(start>1_000_000_000_000_000_000n&&end<9_000_000_000_000_000_000n){
    assert.ok(0n<start&&start<end,`expected 0 < ${start} < ${end}`);
    points++;
   }
  }
 }
 assert.ok(points>=2,'expected cumulative counter and histogram data points');
}

test('pinned actual SDK delivers trace, metric and correlated log protobuf to authenticated loopback HTTP and HTTPS dev-cert', {timeout:15000},async()=>{
 const api=await import('@opentelemetry/api');
 const dir=mkdtempSync(join(tmpdir(),'sf-https-otel-'));
 const {certPem,keyPem}=createLoopbackDevCert();
 const certPath=join(dir,'dev-cert.pem');
 writeFileSync(certPath,certPem);
 try{
  for(const tlsMode of [false,true]){
   const packets=[];
   const handler=async(req,res)=>{
    const chunks=[];
    for await(const chunk of req)chunks.push(chunk);
    packets.push({url:req.url,auth:req.headers['x-otlp-api-key'],contentType:req.headers['content-type'],data:Buffer.concat(chunks)});
    res.writeHead(200,{'content-type':'application/x-protobuf'});res.end();
   };
   const server=tlsMode?createHttpsServer({cert:certPem,key:keyPem},handler):createServer(handler);
   server.listen(0,'127.0.0.1');await once(server,'listening');
   const oldCa=process.env.NODE_EXTRA_CA_CERTS;
   if(tlsMode)process.env.NODE_EXTRA_CA_CERTS=certPath;
   let sdk;
   const globals=[api.trace.getTracerProvider(),api.metrics.getMeterProvider()];
   try {
    const scheme=tlsMode?'https':'http';
    sdk=await startLocalSdk({...configuration,endpoint:`${scheme}://127.0.0.1:`+server.address().port});
    assert.ok(sdk);
    await sdk.observe('evaluate',async()=>{
     assert.equal(api.trace.getTracerProvider(),globals[0]);
     assert.equal(api.metrics.getMeterProvider(),globals[1]);
     return {outcome:'blocked',reason:'POLICY'};
    });
    await sdk.shutdown();
    assert.throws(()=>sdk.observe('evaluate',()=>assert.fail('post-shutdown')),/LOCAL_SDK_STOPPED/);
    sdk=null;
    for(const path of ['/v1/traces','/v1/metrics','/v1/logs']){
     const packet=packets.find(p=>p.url===path);
     assert.ok(packet,'missing '+path);
     assert.equal(packet.auth,'synthetic');assert.match(packet.contentType,/protobuf/);assert.ok(packet.data.length>0);
    }
    const tracePacket=packets.find(p=>p.url==='/v1/traces').data;
    const logPacket=packets.find(p=>p.url==='/v1/logs').data;
    const metricPackets=packets.filter(p=>p.url==='/v1/metrics').map(p=>p.data);
    // Minimal protobuf field reader: compare exact span and log IDs, rather
    // than relying on process-global context or accepting any matching string.
    const field=(buf,wanted)=>{
     let i=0;
     const varint=()=>{let n=0,m=1;for(;;){assert.ok(i<buf.length);const b=buf[i++];n+=(b&127)*m;if(!(b&128))return n;m*=128;}};
     while(i<buf.length){const tag=varint(),wire=tag&7,number=tag>>>3;
      if(wire===2){const size=varint(),v=buf.subarray(i,i+size);i+=size;if(number===wanted)return v;}
      else if(wire===0)varint();else if(wire===1)i+=8;else if(wire===5)i+=4;else assert.fail('unsupported wire type');
     }
     assert.fail('missing protobuf field '+wanted);
    };
    const span=field(field(field(tracePacket,1),2),2),log=field(field(field(logPacket,1),2),2);
    const traceId=field(span,1),spanId=field(span,2);
    assert.equal(traceId.length,16);assert.equal(spanId.length,8);
    assert.deepEqual(field(log,9),traceId);assert.deepEqual(field(log,10),spanId);
    assert.equal(api.trace.getTracerProvider(),globals[0]);assert.equal(api.metrics.getMeterProvider(),globals[1]);
    assert.ok(logPacket.includes(Buffer.from('factory.stage.completed')));
    for(const mp of metricPackets){
     assert.ok(mp.includes(Buffer.from('factory.stage.count')));
     assert.ok(mp.includes(Buffer.from('factory.stage.duration')));
     assertMetricTimestampsMonotonic(mp);
    }
   }finally{
    if(oldCa===undefined)delete process.env.NODE_EXTRA_CA_CERTS;else process.env.NODE_EXTRA_CA_CERTS=oldCa;
    try {if(sdk)await sdk.shutdown();}
    finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
   }
  }
 }finally{
  rmSync(dir,{recursive:true,force:true});
 }
});

test('provider forceFlush and shutdown failures, never-settling watchdogs, and backward wall-clock skew settle fail-closed',{timeout:15000},async()=>{
 let closed=0;
 class Dummy{constructor(options){this.options=options;}}
 class TracerProvider{
  async forceFlush(){throw [Error('span flush failed')];}
  async shutdown(){closed++;await new Promise(()=>{});}
  getTracer(){return {startSpan:()=>({end(){}})};}
 }
 class MeterProvider{
  async forceFlush(){await new Promise(()=>{});}
  async shutdown(){closed++;}
  getMeter(){return {createCounter:()=>({add(){}}),createHistogram:()=>({record(){}})};}
 }
 class LoggerProvider{
  async forceFlush(){}
  async shutdown(){closed++;throw Error('log shutdown failed');}
  getLogger(){return {emit(){}};}
 }
 const api={TracerProvider,MeterProvider,LoggerProvider,ROOT_CONTEXT:{},trace:{setSpan:()=>({})},resourceFromAttributes:a=>a,
  SimpleSpanProcessor:Dummy,SimpleLogRecordProcessor:Dummy,PeriodicExportingMetricReader:Dummy,
  OTLPTraceExporter:Dummy,OTLPMetricExporter:Dummy,OTLPLogExporter:Dummy};
 const sdk=await startLocalSdk(configuration,async()=>api);
 await assert.rejects(
  sdk.shutdown(),
  err=>err instanceof AggregateError &&
   err.message==='LOCAL_SDK_SHUTDOWN_FAILED' &&
   err.errors.some(e=>e.message==='span flush failed') &&
   err.errors.some(e=>e.message==='LOCAL_SDK_FLUSH_TIMEOUT') &&
   err.errors.some(e=>e.message==='LOCAL_SDK_SHUTDOWN_TIMEOUT') &&
   err.errors.some(e=>e.message==='log shutdown failed')
 );
 assert.equal(closed,3);
 assert.throws(()=>sdk.observe('evaluate',()=>assert.fail('post-failed-shutdown')),/LOCAL_SDK_STOPPED/);

 // Backward wall-clock jump is bounded monotonically and still flushes/closes all providers.
 let skewFlushed=0,skewClosed=0;
 class CleanProvider{
  async forceFlush(){skewFlushed++;}
  async shutdown(){skewClosed++;}
  getTracer(){return {startSpan:()=>({end(){}})};}
  getMeter(){return {createCounter:()=>({add(){}}),createHistogram:()=>({record(){}})};}
  getLogger(){return {emit(){}};}
 }
 const cleanApi={TracerProvider:CleanProvider,MeterProvider:CleanProvider,LoggerProvider:CleanProvider,ROOT_CONTEXT:{},trace:{setSpan:()=>({})},resourceFromAttributes:a=>a,
  SimpleSpanProcessor:Dummy,SimpleLogRecordProcessor:Dummy,PeriodicExportingMetricReader:Dummy,
  OTLPTraceExporter:Dummy,OTLPMetricExporter:Dummy,OTLPLogExporter:Dummy};
 const realNow=Date.now;
 let fakeNow=20_000;
 Date.now=()=>fakeNow;
 try{
  const skewSdk=await startLocalSdk(configuration,async()=>cleanApi);
  await skewSdk.observe('evaluate',async()=>({outcome:'blocked',reason:'POLICY'}));
  fakeNow=10_000;
  await assert.rejects(
   skewSdk.shutdown(),
   err=>err instanceof AggregateError &&
    err.message==='LOCAL_SDK_SHUTDOWN_FAILED' &&
    err.errors.some(e=>e.message==='LOCAL_SDK_CLOCK_TIMEOUT')
  );
  assert.equal(skewFlushed,3);
  assert.equal(skewClosed,3);
  assert.throws(()=>skewSdk.observe('evaluate',()=>assert.fail('post-clock-timeout')),/LOCAL_SDK_STOPPED/);
 }finally{
  Date.now=realNow;
 }
});

test('partial provider startup failure attempts all acquired cleanup and preserves original error',async()=>{
 const original=Error('startup failure');
 for(const phase of ['construct','signals'])for(const cleanupFails of [false,true]){
  let cleaned=0;
  class Dummy{constructor(options){this.options=options;}}
  class Provider{async shutdown(){cleaned++;if(cleanupFails)throw Error('cleanup failed');}}
  class TracerProvider extends Provider{getTracer(){throw original;}}
  class MeterProvider extends Provider{constructor(){super();if(phase==='construct')throw original;}}
  const api={TracerProvider:TracerProvider,MeterProvider,LoggerProvider:Provider,resourceFromAttributes:a=>a,
   SimpleSpanProcessor:Dummy,SimpleLogRecordProcessor:Dummy,PeriodicExportingMetricReader:Dummy,
   OTLPTraceExporter:Dummy,OTLPMetricExporter:Dummy,OTLPLogExporter:Dummy};
  await assert.rejects(()=>startLocalSdk(configuration,async()=>api),e=>e===original);
  assert.equal(cleaned, phase === 'construct' ? 1 : 3);
 }
});
test('disabled SDK and inherited unrelated headers never construct exporters',async()=>{
 for(const [key,value] of [['OTEL_SDK_DISABLED','TRUE'],['OTEL_EXPORTER_OTLP_HEADERS','x-otlp-api-key=synthetic,authorization=unrelated'],['OTEL_EXPORTER_OTLP_HEADERS','']]){
  const old=process.env[key];process.env[key]=value;
  try{assert.equal(await startLocalSdk(configuration,async()=>assert.fail('must not load')),null);}
  finally{if(old===undefined)delete process.env[key];else process.env[key]=old;}
 }
});

test('shutdown bounds a hung observation, closes providers and does not rerun accepted work',{timeout:8000},async()=>{
 let closed=0,called=0,release;
 class Dummy{constructor(options){this.options=options;}}
 class Provider{async shutdown(){closed++;}}
 class TracerProvider extends Provider{getTracer(){return {startSpan:()=>({end(){}})};}}
 class MeterProvider extends Provider{getMeter(){return {createCounter:()=>({add(){}}),createHistogram:()=>({record(){}})};}}
 class LoggerProvider extends Provider{getLogger(){return {emit(){}};}}
 const api={TracerProvider,MeterProvider,LoggerProvider,ROOT_CONTEXT:{},trace:{setSpan:()=>({})},resourceFromAttributes:a=>a,
   SimpleSpanProcessor:Dummy,SimpleLogRecordProcessor:Dummy,PeriodicExportingMetricReader:Dummy,
   OTLPTraceExporter:Dummy,OTLPMetricExporter:Dummy,OTLPLogExporter:Dummy};
 const sdk=await startLocalSdk(configuration,async()=>api);
 const gate=new Promise(resolve=>{release=resolve;});
 const work=sdk.observe('evaluate',async()=>{called++;await gate;return {outcome:'blocked',reason:'POLICY'};});
 try{
  await assert.rejects(sdk.shutdown(),error => (error instanceof AggregateError) && error.errors.some(e => e.message === 'LOCAL_SDK_DRAIN_TIMEOUT'));
  assert.equal(closed,3);assert.equal(called,1);
 } finally {release();await work;}
});

for (const mode of ['reject', 'unanswered', 'streaming']) {
 test('real local exporters tolerate '+mode+' responses without changing work', {timeout:15000}, async()=>{
  const seen=new Set(),closed=new Set();
  const server=createServer(async(req,res)=>{
   let bytes=0;
   for await (const chunk of req) bytes+=chunk.length;
   assert.ok(bytes>0,'export request must contain protobuf');
   if(req.headers['x-otlp-api-key']==='synthetic')seen.add(req.url);
   if(mode==='reject'){res.writeHead(400);res.end();}
   if(mode==='streaming'){
    res.writeHead(200,{'content-type':'application/x-protobuf'});
    res.write(Buffer.from([0]));
    const interval=setInterval(()=>res.write(Buffer.from([0])),50);
    res.once('close',()=>{clearInterval(interval);closed.add(req.url);});
   }
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  let sdk;
  try{
   sdk=await startLocalSdk({...configuration,endpoint:'http://127.0.0.1:'+server.address().port});
   assert.ok(sdk);
   const expected={outcome:'blocked',reason:'POLICY'};
   let calls=0;
   assert.deepEqual(await sdk.observe('evaluate',async()=>{calls++;return expected;}),expected);
   assert.equal(calls,1);
   const start=performance.now();
   // Pinned exporters may report failed exports through diagnostics or
   // reject provider shutdown. Either way cleanup must settle, not hang.
   const result=await sdk.shutdown().then(()=>null,error=>error);
   assert.ok(performance.now()-start<10000,'shutdown exceeded 10s test bound');
   if(result!==null)assert.ok(result instanceof AggregateError && result.message==='LOCAL_SDK_SHUTDOWN_FAILED');
   const expectedPaths=['/v1/logs','/v1/metrics','/v1/traces'];
   assert.deepEqual([...seen].sort(),expectedPaths);
   if(mode==='streaming'){
    // Observe the remote side closing, not merely a local promise settling.
    const deadline=performance.now()+1000;
    while(closed.size<3 && performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.deepEqual([...closed].sort(),expectedPaths);
   }
   sdk=null;
  }finally{
   server.closeAllConnections();
   await new Promise(resolve=>server.close(resolve));
   if(sdk)await sdk.shutdown().catch(()=>{});
  }
 });
}

test('TLS verification override refuses authenticated HTTPS export before loading the SDK',async()=>{
 const key='NODE_TLS_REJECT_UNAUTHORIZED',old=process.env[key];
 process.env[key]='0';
 try{
  await assert.doesNotReject(async()=>{
   assert.equal(await startLocalSdk({...configuration,endpoint:'https://127.0.0.1:4318'},async()=>assert.fail('must not load')),null);
  });
 }finally{if(old===undefined)delete process.env[key];else process.env[key]=old;}
});
