// Explicit, local-only SDK bootstrap; keep the evaluator and normal headless
// test runner independent of optional telemetry dependencies.
import {localOtlpConfiguration,createSignals} from './telemetry.mjs';

// Only reached after explicit endpoint/protocol/header validation.
async function loadPinnedSdk() {
  const [api,node,trace,metrics,logs,resources,traceExporter,metricExporter,logExporter]=await Promise.all([
    import('@opentelemetry/api'),import('@opentelemetry/sdk-node'),import('@opentelemetry/sdk-trace'),
    import('@opentelemetry/sdk-metrics'),import('@opentelemetry/sdk-logs'),import('@opentelemetry/resources'),
    import('@opentelemetry/exporter-trace-otlp-proto'),import('@opentelemetry/exporter-metrics-otlp-proto'),import('@opentelemetry/exporter-logs-otlp-proto')
  ]);
  return {...api,...node,...trace,...metrics,...logs,...resources,...traceExporter,...metricExporter,...logExporter};
}
export async function startLocalSdk(config,load=loadPinnedSdk) {
  const local=localOtlpConfiguration(config.endpoint,config.protocol,config.headers);
  if(!local||local.protocol!=='http/protobuf') return null;
  // Reject alternate exporter endpoints, credentials, proxies or untrusted
  // instrumentation overrides rather than let SDK environment defaults leak.
  for(const [key,value] of Object.entries(process.env)) {
    if(value&&(/^(?:OTEL_EXPORTER_OTLP_.+|OTEL_(?:TRACES|METRICS|LOGS)_EXPORTER|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NODE_USE_ENV_PROXY)$/i.test(key))&&
      !['OTEL_EXPORTER_OTLP_ENDPOINT','OTEL_EXPORTER_OTLP_PROTOCOL','OTEL_EXPORTER_OTLP_HEADERS'].includes(key))
      return null;
  }
  const api=await load();
  const options=signal=>({url:local.endpoint+'/v1/'+signal,headers:local.headers,timeoutMillis:3000});
  // No automatic instrumentation, environment resource detector, or external
  // default exporter. A single explicitly constructed local exporter per signal.
  const sdk=new api.NodeSDK({
    autoDetectResources:false,
    resource:api.resourceFromAttributes({'service.name':'softwarefactory-shadow'}),
    instrumentations:[],
    spanProcessors:[new api.SimpleSpanProcessor(new api.OTLPTraceExporter(options('traces')))],
    metricReaders:[new api.PeriodicExportingMetricReader({exporter:new api.OTLPMetricExporter(options('metrics')),exportIntervalMillis:3000,exportTimeoutMillis:3000})],
    logRecordProcessors:[new api.SimpleLogRecordProcessor(new api.OTLPLogExporter(options('logs')))]
  });
  sdk.start();
  return {
    observe:createSignals({tracer:api.trace.getTracer('softwarefactory'),meter:api.metrics.getMeter('softwarefactory'),logger:api.logs.getLogger('softwarefactory')}),
    shutdown:()=>sdk.shutdown()
  };
}
