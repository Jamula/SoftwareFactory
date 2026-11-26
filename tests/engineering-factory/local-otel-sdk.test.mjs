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
test('explicit local exporters and SDK lifecycle, with no implicit discovery',async()=>{
 const opts=[],events=[];
 class Exporter{constructor(options){opts.push(options);}}
 class Processor{constructor(exporter){this.exporter=exporter;}}
 class Reader{constructor(options){this.options=options;}}
 class SDK{constructor(options){this.options=options;events.push(options);}start(){events.push('start');}async shutdown(){events.push('shutdown');}}
 const api={
  NodeSDK:SDK,resourceFromAttributes:a=>a,SimpleSpanProcessor:Processor,SimpleLogRecordProcessor:Processor,PeriodicExportingMetricReader:Reader,
  OTLPTraceExporter:Exporter,OTLPMetricExporter:Exporter,OTLPLogExporter:Exporter,
  trace:{getTracer:()=>({startActiveSpan:(n,fn)=>fn({end(){}})})},
  metrics:{getMeter:()=>({createCounter:()=>({add(){}}),createHistogram:()=>({record(){}})})},
  logs:{getLogger:()=>({emit:r=>events.push(r)})}
 };
 const sdk=await startLocalSdk(configuration,async()=>api);
 assert.deepEqual(opts,['traces','metrics','logs'].map(s=>({url:'http://127.0.0.1:4318/v1/'+s,headers:{'x-otlp-api-key':'synthetic'},timeoutMillis:3000})));
 assert.equal(events[0].autoDetectResources,false);
 assert.deepEqual(events[0].instrumentations,[]);
 assert.deepEqual(events[0].resource,{'service.name':'softwarefactory-shadow'});
 assert.equal(events[0].metricReaders[0].options.exportIntervalMillis,1000);
 assert.equal(events[1],'start');
 assert.deepEqual(await sdk.observe('evaluate',async()=>({outcome:'blocked',reason:'POLICY'})),{outcome:'blocked',reason:'POLICY'});
 assert.equal(events[2].body,'factory.stage.completed');
 await sdk.shutdown();assert.equal(events.at(-1),'shutdown');
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
 let sdk,traceId,spanId;
 try {
  sdk=await startLocalSdk({...configuration,endpoint:'http://127.0.0.1:'+server.address().port});
  assert.ok(sdk);
  await sdk.observe('evaluate',async()=>{
   const ctx=api.trace.getSpan(api.context.active()).spanContext();
   traceId=ctx.traceId;spanId=ctx.spanId;
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
  assert.ok(tracePacket.includes(Buffer.from(traceId,'hex')));
  assert.ok(logPacket.includes(Buffer.from(traceId,'hex')));
  assert.ok(logPacket.includes(Buffer.from(spanId,'hex')));
  assert.ok(logPacket.includes(Buffer.from('factory.stage.completed')));
  assert.ok(metricPacket.includes(Buffer.from('factory.stage.count')));
 }finally{
  if(sdk)await sdk.shutdown();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 }
});
