const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
const categories=new Set(['test','infra','dependency','permission','coverage','security']);
const own=(v,k)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&k.every(x=>Object.hasOwn(v,x));
const result=(category,action)=>({shadow:true,category,action,skipRequiredChecks:false,liveRetry:false});
export function diagnose(e,head) {
 if(!sha(head)||!own(e,['head','complete','category','attempt','retryLimit','transient'])||e.head!==head||e.complete!==true||typeof e.transient!=='boolean'||!categories.has(e.category)||!Number.isSafeInteger(e.attempt)||e.attempt<0||!Number.isSafeInteger(e.retryLimit)||e.retryLimit<0||e.retryLimit>2) return result('unknown','investigate');
 if(e.category==='infra'&&e.transient===true&&e.attempt<e.retryLimit) return result('infra','consider-retry');
 return result(e.category,'repair-or-investigate');
}
