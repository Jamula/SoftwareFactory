// Explicit, local-only SDK bootstrap; keep the evaluator and normal headless
// test runner independent of optional telemetry dependencies.
import {AsyncLocalStorage} from 'node:async_hooks';
import {X509Certificate} from 'node:crypto';
import {closeSync,constants,fstatSync,lstatSync,openSync,readFileSync} from 'node:fs';
import {rootCertificates} from 'node:tls';
import {localOtlpConfiguration,createSignals} from './telemetry.mjs';

const DEADLINE_MS=3000;
const CLOCK_DEADLINE_MS=100;
const PEM_CERT_BLOCK=/-----BEGIN CERTIFICATE-----\r?\n[\s\S]+?\r?\n-----END CERTIFICATE-----/g;
const FORBIDDEN_ENV=/^(?:OTEL_EXPORTER_OTLP_.+|OTEL_(?:TRACES|METRICS|LOGS)_EXPORTER|(?:HTTP|HTTPS|ALL|NO)_PROXY|NODE_USE_ENV_PROXY|NODE_TLS_REJECT_UNAUTHORIZED)$/;

function readTrustedCa(caPath) {
  if(typeof caPath!=='string'||!caPath.trim()||caPath.includes('\0'))return null;
  try {
    const fd=openSync(caPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      const stat=fstatSync(fd);
      if(!stat.isFile()||stat.size<=0||stat.size>1048576||(stat.mode&0o444)===0)return null;
      const pem=readFileSync(fd,'utf8');
      if(lstatSync(caPath).isSymbolicLink())return null;
      const blocks=pem.match(PEM_CERT_BLOCK);
      if(!blocks||pem.replace(PEM_CERT_BLOCK,'').trim())return null;
      for(const block of blocks)new X509Certificate(block);
      return blocks.join('\n')+'\n';
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

// Reject alternate exporter endpoints, credentials, proxies, untrusted CA paths
// or TLS-verification overrides before loading any SDK modules.
export function validateLocalOtlpEnvironment(config,env=process.env) {
  if(!config||typeof config!=='object'||!env||typeof env!=='object')return null;
  const local=localOtlpConfiguration(config.endpoint,config.protocol,config.headers);
  if(!local||local.protocol!=='http/protobuf')return null;
  let extraCa,seenCa=false;
  for(const [key,value] of Object.entries(env)) {
    if(value===undefined)continue;
    const upper=key.toUpperCase();
    if(upper==='OTEL_SDK_DISABLED') {
      if(String(value).trim().toLowerCase()==='true')return null;
    } else if(upper==='OTEL_EXPORTER_OTLP_ENDPOINT') {
      if(value!==config.endpoint)return null;
    } else if(upper==='OTEL_EXPORTER_OTLP_PROTOCOL') {
      if(value!==config.protocol)return null;
    } else if(upper==='OTEL_EXPORTER_OTLP_HEADERS') {
      if(value!==config.headers)return null;
    } else if(upper==='NODE_EXTRA_CA_CERTS') {
      if(seenCa)return null;
      seenCa=true;
      extraCa=readTrustedCa(value);
      if(!extraCa)return null;
    } else if(FORBIDDEN_ENV.test(upper)||(upper==='NODE_OPTIONS'&&/--use-env-proxy(?:\s|=|$)/.test(String(value)))) {
      return null;
    }
  }
  return {...local,extraCa};
}

// Only reached after explicit endpoint/protocol/header validation.
async function loadPinnedSdk() {
  const [api,trace,metrics,logs,resources,traceExporter,metricExporter,logExporter]=await Promise.all([
    import('@opentelemetry/api'),import('@opentelemetry/sdk-trace'),
    import('@opentelemetry/sdk-metrics'),import('@opentelemetry/sdk-logs'),import('@opentelemetry/resources'),
    import('@opentelemetry/exporter-trace-otlp-proto'),import('@opentelemetry/exporter-metrics-otlp-proto'),import('@opentelemetry/exporter-logs-otlp-proto')
  ]);
  return {...api,...trace,...metrics,...logs,...resources,...traceExporter,...metricExporter,...logExporter};
}
export async function startLocalSdk(config,load=loadPinnedSdk,env=process.env) {
  const local=validateLocalOtlpEnvironment(config,env);
  if(!local||(env!==process.env&&!validateLocalOtlpEnvironment(config,process.env)))return null;
  const api=await load();
  // The pinned exporter's request timeout measures inactivity, not elapsed
  // time. Its supported custom-agent factory lets us enforce an absolute
  // deadline even for a collector that continuously streams a response.
  const deadlineAgent=async protocol=>{
    const {Agent}=protocol==='http:'?await import('node:http'):await import('node:https');
    const agentOptions=protocol==='https:'&&local.extraCa
      ?{keepAlive:false,rejectUnauthorized:true,ca:[...rootCertificates,local.extraCa]}
      :{keepAlive:false,rejectUnauthorized:true};
    return new class extends Agent {
      addRequest(request,options){
        const timer=setTimeout(()=>request.destroy(Error('LOCAL_OTLP_REQUEST_DEADLINE')),DEADLINE_MS);
        request.once('close',()=>clearTimeout(timer));
        super.addRequest(request,options);
      }
    }(agentOptions);
  };
  const options=signal=>({url:local.endpoint+'/v1/'+signal,headers:local.headers,timeoutMillis:DEADLINE_MS,httpAgentOptions:deadlineAgent});
  // Own the providers and their lifetime; never register or look up a global
  // provider or context manager. Existing process instrumentation is untouched.
  const resource=api.resourceFromAttributes({'service.name':'softwarefactory-shadow'});
  const providers=[];
  const storage=new AsyncLocalStorage();
  const active=new Set();
  let stopped,closed=false,observed=false,lastObservedAt=0;
  const runBounded=(fn,timeoutCode)=>{
    let timer;
    const task=Promise.resolve().then(fn);
    task.catch(()=>{});
    return Promise.race([
      task,
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(timeoutCode)),DEADLINE_MS);})
    ]).finally(()=>clearTimeout(timer));
  };
  const shutdown=()=>stopped??=(async()=>{
    // Reject new stages immediately; give already accepted work a bounded
    // opportunity to emit completion signals before flushing our providers.
    let drained=true;
    if(active.size){
      let timer;
      try {
        drained=await Promise.race([
          Promise.allSettled([...active]).then(()=>true),
          new Promise(resolve=>{timer=setTimeout(()=>resolve(false),DEADLINE_MS);})
        ]);
      } finally {clearTimeout(timer);}
    }
    closed=true;
    // Ensure cumulative OTLP collection timestamp strictly succeeds the initial
    // observation millisecond across coarse timer boundaries, bounded monotonically
    // if the wall clock steps backward.
    const clockDeadline=performance.now()+CLOCK_DEADLINE_MS;
    while(observed&&Date.now()<=lastObservedAt&&performance.now()<clockDeadline){
      await new Promise(resolve=>setTimeout(resolve,2));
    }
    const clockAdvanced=!observed||Date.now()>lastObservedAt;
    const flushResults=await Promise.allSettled(
      providers.filter(p=>typeof p.forceFlush==='function').map(p=>runBounded(()=>p.forceFlush({timeoutMillis:DEADLINE_MS}),'LOCAL_SDK_FLUSH_TIMEOUT'))
    );
    const shutdownResults=await Promise.allSettled(
      providers.map(p=>runBounded(()=>p.shutdown({timeoutMillis:DEADLINE_MS}),'LOCAL_SDK_SHUTDOWN_TIMEOUT'))
    );
    storage.disable();
    const failures=[...flushResults,...shutdownResults]
      .filter(r=>r.status==='rejected')
      .flatMap(r=>Array.isArray(r.reason)?r.reason:[r.reason]);
    if(!drained)failures.push(Error('LOCAL_SDK_DRAIN_TIMEOUT'));
    if(!clockAdvanced)failures.push(Error('LOCAL_SDK_CLOCK_TIMEOUT'));
    if(failures.length)throw new AggregateError(failures,'LOCAL_SDK_SHUTDOWN_FAILED');
  })();
  try {
    const tracerProvider=new api.TracerProvider({resource,spanProcessors:[new api.SimpleSpanProcessor({exporter:new api.OTLPTraceExporter(options('traces'))})]});
    providers.push(tracerProvider);
    const meterProvider=new api.MeterProvider({resource,readers:[new api.PeriodicExportingMetricReader({exporter:new api.OTLPMetricExporter(options('metrics')),exportIntervalMillis:DEADLINE_MS,exportTimeoutMillis:DEADLINE_MS})]});
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
      logger:{emit(record){if(!closed)logger.emit({...record,context:storage.getStore()??api.ROOT_CONTEXT});}}
    });
    return {observe(stage,work){
      if(stopped)throw Error('LOCAL_SDK_STOPPED');
      const pending=Promise.resolve().then(()=>observe(stage,work)).finally(()=>{
        if(!closed){lastObservedAt=Date.now();observed=true;}
        active.delete(pending);
      });
      active.add(pending);
      return pending;
    },shutdown};
  } catch(error) {
    try {await shutdown();} catch {}
    throw error;
  }
}
