// Explicit, local-only SDK bootstrap; keep the evaluator and normal headless
// test runner independent of optional telemetry dependencies.
import {AsyncLocalStorage} from 'node:async_hooks';
import {localOtlpConfiguration,createSignals} from './telemetry.mjs';

// Only reached after explicit endpoint/protocol/header validation.
async function loadPinnedSdk() {
  const [api,trace,metrics,logs,resources,traceExporter,metricExporter,logExporter]=await Promise.all([
    import('@opentelemetry/api'),import('@opentelemetry/sdk-trace'),
    import('@opentelemetry/sdk-metrics'),import('@opentelemetry/sdk-logs'),import('@opentelemetry/resources'),
    import('@opentelemetry/exporter-trace-otlp-proto'),import('@opentelemetry/exporter-metrics-otlp-proto'),import('@opentelemetry/exporter-logs-otlp-proto')
  ]);
  return {...api,...trace,...metrics,...logs,...resources,...traceExporter,...metricExporter,...logExporter};
}
export async function startLocalSdk(config,load=loadPinnedSdk) {
  if(process.env.OTEL_SDK_DISABLED?.toLowerCase()==='true') return null;
  const local=localOtlpConfiguration(config.endpoint,config.protocol,config.headers);
  if(!local||local.protocol!=='http/protobuf') return null;
  // Reject alternate exporter endpoints, credentials, proxies or untrusted
  // instrumentation or TLS-verification overrides rather than let SDK
  // environment defaults leak. Trusted development CAs remain supported.
  if(process.env.OTEL_EXPORTER_OTLP_HEADERS!==undefined&&process.env.OTEL_EXPORTER_OTLP_HEADERS!==config.headers) return null;
  for(const [key,value] of Object.entries(process.env)) {
    if(value&&(/^(?:OTEL_EXPORTER_OTLP_.+|OTEL_(?:TRACES|METRICS|LOGS)_EXPORTER|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NODE_USE_ENV_PROXY|NODE_TLS_REJECT_UNAUTHORIZED)$/i.test(key))&&
      !['OTEL_EXPORTER_OTLP_ENDPOINT','OTEL_EXPORTER_OTLP_PROTOCOL','OTEL_EXPORTER_OTLP_HEADERS'].includes(key))
      return null;
  }
  const api=await load();
  const options=signal=>({url:local.endpoint+'/v1/'+signal,headers:local.headers,timeoutMillis:3000});
  // Own the providers and their lifetime; never register or look up a global
  // provider or context manager. Existing process instrumentation is untouched.
  const resource=api.resourceFromAttributes({'service.name':'softwarefactory-shadow'});
  const providers=[];
  const storage=new AsyncLocalStorage();
  const active=new Set();
  let stopped;
  const shutdown=()=>stopped??=(async()=>{
    // Reject new stages immediately; give already accepted work a bounded
    // opportunity to emit completion signals before closing our providers.
    let drained=true;
    if(active.size){
      let timer;
      try {
        drained=await Promise.race([
          Promise.allSettled([...active]).then(()=>true),
          new Promise(resolve=>{timer=setTimeout(()=>resolve(false),3000);})
        ]);
      } finally {clearTimeout(timer);}
    }
    const results=await Promise.allSettled(providers.map(p=>Promise.resolve().then(()=>p.shutdown())));
    storage.disable();
    const failures=results.filter(r=>r.status==='rejected').map(r=>r.reason);
    if(!drained)failures.push(Error('LOCAL_SDK_DRAIN_TIMEOUT'));
    if(failures.length)throw new AggregateError(failures,'LOCAL_SDK_SHUTDOWN_FAILED');
  })();
  try {
    const tracerProvider=new api.TracerProvider({resource,spanProcessors:[new api.SimpleSpanProcessor({exporter:new api.OTLPTraceExporter(options('traces'))})]});
    providers.push(tracerProvider);
    const meterProvider=new api.MeterProvider({resource,readers:[new api.PeriodicExportingMetricReader({exporter:new api.OTLPMetricExporter(options('metrics')),exportIntervalMillis:3000,exportTimeoutMillis:3000})]});
    providers.push(meterProvider);
    const loggerProvider=new api.LoggerProvider({resource,processors:[new api.SimpleLogRecordProcessor({exporter:new api.OTLPLogExporter(options('logs'))})]});
    providers.push(loggerProvider);
    const tracer=tracerProvider.getTracer('softwarefactory');
    const meter=meterProvider.getMeter('softwarefactory');
    const logger=loggerProvider.getLogger('softwarefactory');
    const observe=createSignals({
      tracer:{startActiveSpan(name,fn){
        const parent=storage.getStore()??api.ROOT_CONTEXT;
        const span=tracer.startSpan(name,{},parent);
        return storage.run(api.trace.setSpan(parent,span),()=>fn(span));
      }},
      meter,
      logger:{emit(record){logger.emit({...record,context:storage.getStore()??api.ROOT_CONTEXT});}}
    });
    return {observe(stage,work){
      if(stopped)throw Error('LOCAL_SDK_STOPPED');
      const pending=Promise.resolve().then(()=>observe(stage,work));
      active.add(pending);
      pending.then(()=>active.delete(pending),()=>active.delete(pending));
      return pending;
    },shutdown};
  } catch(error) {
    try {await shutdown();} catch {}
    throw error;
  }
}
