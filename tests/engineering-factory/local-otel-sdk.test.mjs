import test from 'node:test';
import assert from 'node:assert/strict';
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
