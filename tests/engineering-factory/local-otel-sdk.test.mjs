import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {startLocalSdk} from '../../tools/engineering-factory/local-otel-sdk.mjs';
const configuration={endpoint:'http://127.0.0.1:4318',protocol:'http/protobuf',headers:'x-otlp-api-key=synthetic'};
test('disabled or invalid local SDK never imports dependencies',async()=>{
 let calls=0;
 const load=async()=>{calls++;throw Error('must not load');};
 for(const config of [{},{...configuration,endpoint:'https://remote.example:4318'},{...configuration,protocol:'grpc'},{...configuration,headers:''}])
  assert.equal(await startLocalSdk(config,load),null);
 assert.equal(calls,0);
});
test('explicit private providers and SDK lifecycle, with no global registration',async()=>{
 const opts=[],events=[],configs=[];
 class Exporter{constructor(options){opts.push(options);}}
 class Processor{constructor({exporter}){assert.ok(exporter instanceof Exporter);this.exporter=exporter;}}
 class Reader{constructor(options){this.options=options;}}
 class Provider{constructor(options){configs.push(options);}async shutdown(){events.push('shutdown');}}
 class TracerProvider extends Provider{getTracer(){return {startSpan:(name,options,parent)=>({end(){},name,parent})};}}
 class MeterProvider extends Provider{getMeter(){return {createCounter:()=>({add(){}}),createHistogram:()=>({record(){}})};}}
 class LoggerProvider extends Provider{getLogger(){return {emit:r=>events.push(r)};}}
 const root={root:true};
 const api={TracerProvider:TracerProvider,MeterProvider,LoggerProvider,ROOT_CONTEXT:root,
  resourceFromAttributes:a=>a,SimpleSpanProcessor:Processor,SimpleLogRecordProcessor:Processor,PeriodicExportingMetricReader:Reader,
  OTLPTraceExporter:Exporter,OTLPMetricExporter:Exporter,OTLPLogExporter:Exporter,
  trace:{setSpan:(parent,span)=>({parent,span}),getTracer(){assert.fail('global tracer');}},
  metrics:{getMeter(){assert.fail('global meter');}},logs:{getLogger(){assert.fail('global logger');}}
 };
 const sdk=await startLocalSdk(configuration,async()=>api);
 assert.deepEqual(opts,['traces','metrics','logs'].map(s=>({url:'http://127.0.0.1:4318/v1/'+s,headers:{'x-otlp-api-key':'synthetic'},timeoutMillis:3000})));
 assert.ok(configs.every(c=>c.resource['service.name']==='softwarefactory-shadow'));
 assert.equal(configs[1].readers[0].options.exportIntervalMillis,3000);
 assert.ok(configs[1].readers[0].options.exportIntervalMillis>=configs[1].readers[0].options.exportTimeoutMillis);
 assert.deepEqual(await sdk.observe('evaluate',async()=>({outcome:'blocked',reason:'POLICY'})),{outcome:'blocked',reason:'POLICY'});
 assert.equal(events[0].body,'factory.stage.completed');
 assert.equal(events[0].context.span.name,'factory.evaluate');
 let release;
 const gate=new Promise(resolve=>{release=resolve;});
 const accepted=sdk.observe('evaluate',async()=>{await gate;return {outcome:'blocked',reason:'POLICY'};});
 const rejected=sdk.observe('evaluate',async()=>{throw Error('work failure');});
 const rejection=assert.rejects(rejected,/work failure/);
 const done=sdk.shutdown();assert.equal(sdk.shutdown(),done);
 assert.throws(()=>sdk.observe('evaluate',()=>assert.fail('stopped')),/LOCAL_SDK_STOPPED/);
 await rejection;assert.equal(events.includes('shutdown'),false);
 release();await accepted;await done;
 assert.equal(events.filter(x=>x==='shutdown').length,3);
 assert.throws(()=>sdk.observe('evaluate',()=>assert.fail('stopped')),/LOCAL_SDK_STOPPED/);
});
test('startup and dependency failure cannot manufacture SDK readiness',async()=>{
 const error=Error('unavailable');
 await assert.rejects(()=>startLocalSdk(configuration,async()=>{throw error;}),e=>e===error);
});

test('untrusted exporter overrides fail before SDK loading',async()=>{
 const key='OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',old=process.env[key];
 process.env[key]='https://remote.invalid';
 try {assert.equal(await startLocalSdk(configuration,async()=>assert.fail('must not load')),null);}
 finally {if(old===undefined)delete process.env[key];else process.env[key]=old;}
});
test('pinned actual SDK delivers trace, metric and correlated log protobuf to authenticated loopback', {timeout:15000},async()=>{
 const api=await import('@opentelemetry/api');
 const packets=[];
 const server=createServer(async(req,res)=>{
  const chunks=[];
  for await(const chunk of req)chunks.push(chunk);
  packets.push({url:req.url,auth:req.headers['x-otlp-api-key'],contentType:req.headers['content-type'],data:Buffer.concat(chunks)});
  res.writeHead(200,{'content-type':'application/x-protobuf'});res.end();
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 let sdk;
 const globals=[api.trace.getTracerProvider(),api.metrics.getMeterProvider()];
 try {
  sdk=await startLocalSdk({...configuration,endpoint:'http://127.0.0.1:'+server.address().port});
  assert.ok(sdk);
  await sdk.observe('evaluate',async()=>{
   assert.equal(api.trace.getTracerProvider(),globals[0]);
   assert.equal(api.metrics.getMeterProvider(),globals[1]);
   return {outcome:'blocked',reason:'POLICY'};
  });
  await sdk.shutdown();sdk=null;
  for(const path of ['/v1/traces','/v1/metrics','/v1/logs']){
   const packet=packets.find(p=>p.url===path);
   assert.ok(packet,'missing '+path);
   assert.equal(packet.auth,'synthetic');assert.match(packet.contentType,/protobuf/);assert.ok(packet.data.length>0);
  }
  const tracePacket=packets.find(p=>p.url==='/v1/traces').data;
  const logPacket=packets.find(p=>p.url==='/v1/logs').data;
  const metricPacket=packets.find(p=>p.url==='/v1/metrics').data;
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
  assert.ok(metricPacket.includes(Buffer.from('factory.stage.count')));
 }finally{
  try {if(sdk)await sdk.shutdown();}
  finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
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

for (const mode of ['reject', 'unanswered']) {
 test('real local exporters tolerate '+mode+' responses without changing work', {timeout:15000}, async()=>{
  const seen=new Set();
  const server=createServer(async(req,res)=>{
   let bytes=0;
   for await (const chunk of req) bytes+=chunk.length;
   assert.ok(bytes>0,'export request must contain protobuf');
   if(req.headers['x-otlp-api-key']==='synthetic')seen.add(req.url);
   if(mode==='reject'){res.writeHead(400);res.end();}
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
   assert.deepEqual([...seen].sort(),['/v1/logs','/v1/metrics','/v1/traces']);
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
