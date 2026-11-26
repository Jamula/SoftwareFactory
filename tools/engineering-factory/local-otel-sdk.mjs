// Explicit, local-only SDK bootstrap; keep the evaluator and normal headless
// test runner independent of optional telemetry dependencies.
import {localOtlpConfiguration,createSignals} from './telemetry.mjs';

export async function startLocalSdk(config,load) {
  const local=localOtlpConfiguration(config.endpoint,config.protocol,config.headers);
  if(!local||local.protocol!=='http/protobuf') return null;
  const api=await load();
  const options=signal=>({url:local.endpoint+'/v1/'+signal,headers:local.headers,timeoutMillis:3000});
  // No automatic instrumentation, environment resource detector, or external
  // default exporter. A single explicitly constructed local exporter per signal.
  const sdk=new api.NodeSDK({
    autoDetectResources:false,
    resource:api.resourceFromAttributes({'service.name':'softwarefactory-shadow'}),
    instrumentations:[],
    spanProcessors:[new api.SimpleSpanProcessor(new api.OTLPTraceExporter(options('traces')))],
    metricReaders:[new api.PeriodicExportingMetricReader({exporter:new api.OTLPMetricExporter(options('metrics')),exportIntervalMillis:1000,exportTimeoutMillis:3000})],
    logRecordProcessors:[new api.SimpleLogRecordProcessor(new api.OTLPLogExporter(options('logs')))]
  });
  sdk.start();
  return {
    observe:createSignals({tracer:api.trace.getTracer('softwarefactory'),meter:api.metrics.getMeter('softwarefactory'),logger:api.logs.getLogger('softwarefactory')}),
    shutdown:()=>sdk.shutdown()
  };
}
