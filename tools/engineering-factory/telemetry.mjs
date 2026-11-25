// OpenTelemetry API boundary; dependencies are injected by a separately configured local SDK.
const stages=new Set(['reconcile','normalize','evaluate','queue','review','merge-shadow','verify-main']);
const outcomes=new Set(['eligible','blocked','failed','unknown']);
const reasons=new Set(['NONE','INVALID_EVIDENCE','STALE','DEPENDENCY','QUOTA','POLICY','SECURITY','OTHER']);
export function localEndpoint(value) {
  try {
    const u=new URL(value);
    return ['http:','https:'].includes(u.protocol) && ['127.0.0.1','[::1]'].includes(u.hostname) &&
      u.port!=='' && !u.username && !u.password && !u.search && !u.hash && u.pathname==='/' ? u.origin : null;
  } catch { return null; }
}
export function createSignals({tracer,meter,clock=()=>performance.now()}) {
  let count={add:()=>{}};
  let duration={record:()=>{}};
  try {count=meter.createCounter('factory.stage.count');} catch {}
  try {duration=meter.createHistogram('factory.stage.duration',{unit:'ms'});} catch {}
  const now=()=>{try {return clock();} catch {return NaN;}};
  return async function observe(stage,work) {
    if(!stages.has(stage)) throw new Error('UNKNOWN_STAGE');
    const start=now();
    let pending;
    const execute=async span=>{
      let outcome='failed',reason='OTHER';
      try {
        const result=await work();
        outcome=outcomes.has(result?.outcome)?result.outcome:'unknown';
        reason=reasons.has(result?.reason)?result.reason:'OTHER';
        return result;
      } finally {
        const attributes={stage,outcome,reason};
        const elapsed=now()-start;
        try {count.add(1,attributes);} catch {}
        try {if(Number.isFinite(elapsed)&&elapsed>=0) duration.record(elapsed,attributes);} catch {}
        try {span?.setAttributes(attributes);} catch {}
        try {if(outcome==='failed') span?.setStatus({code:2});} catch {}
        try {span?.end();} catch {}
      }
    };
    // The SDK invokes its callback synchronously in the active context.
    // Retain the original work promise even if the provider throws afterwards.
    const once=span=>pending??=execute(span);
    try {
      if(typeof tracer.startActiveSpan==='function') {
        await tracer.startActiveSpan('factory.'+stage,once);
      } else {
        once(tracer.startSpan('factory.'+stage));
      }
    } catch {}
    return pending??once(undefined);
  };
}
