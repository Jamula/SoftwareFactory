const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const own=(x,k)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&k.every(p=>Object.hasOwn(Object.getOwnPropertyDescriptor(x,p)??{},'value'));
const name=x=>typeof x==='string'&&/^[a-z0-9][a-z0-9._-]{0,79}$/.test(x);
// Accept ordinary, bounded data arrays only; reject accessors and custom behavior.
const dense=x=>Array.isArray(x)&&Object.getPrototypeOf(x)===Array.prototype&&x.length<=250&&Reflect.ownKeys(x).length===x.length+1&&Array.from({length:x.length},(_,i)=>Object.hasOwn(Object.getOwnPropertyDescriptor(x,i)??{},'value')).every(Boolean);
const count=(a,b)=>Number.isSafeInteger(a)&&Number.isSafeInteger(b)&&a>=0&&b>0&&a<=b&&b<=100000000;
const deny=reason=>({shadow:true,valid:false,reason});
export function coverageEvidence(head,expected,reports){
 if(!sha(head)||!dense(expected)||!expected.length||!expected.every(name)||new Set(expected).size!==expected.length||!dense(reports)||reports.length!==expected.length)return deny('INVENTORY_UNKNOWN');
 const seen=new Set();let lines=0,lineTotal=0,branches=0,branchTotal=0;
 for(const r of reports){
  if(!own(r,['component','head','lines','lineTotal','branches','branchTotal'])||!expected.includes(r.component)||seen.has(r.component)||r.head!==head||!count(r.lines,r.lineTotal)||!count(r.branches,r.branchTotal))return deny('INVALID_REPORT');
  if(r.lines*100<95*r.lineTotal||r.branches*100<90*r.branchTotal)return deny('COMPONENT_BELOW_TARGET');
  seen.add(r.component);lines+=r.lines;lineTotal+=r.lineTotal;branches+=r.branches;branchTotal+=r.branchTotal;
 }
 return {shadow:true,valid:true,reason:'COUNTS_ONLY',lines,lineTotal,branches,branchTotal};
}
