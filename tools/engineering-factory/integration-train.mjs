const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
const positive=n=>Number.isSafeInteger(n)&&n>0;
const own=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&keys.every(k=>Object.hasOwn(v,k));
const dense=a=>Array.isArray(a)&&Object.keys(a).length===a.length&&Array.from({length:a.length},(_,i)=>Object.hasOwn(a,i)).every(Boolean);
const blocked=reason=>({shadow:true,liveMerge:false,reason});
export function nextIntegration(state) {
 if(!own(state,['stop','main','mainHealthy','active','candidates'])||state.stop!==false) return blocked('STOPPED');
 if(!sha(state.main)||state.mainHealthy!==true||state.active!==false) return blocked('MAIN_OR_TRAIN_UNREADY');
 if(!dense(state.candidates)||state.candidates.some(c=>!own(c,['pr','head','observedHead','base','checks','approval','threads','authority'])||!positive(c.pr)||!sha(c.head)||!sha(c.observedHead)||!sha(c.base))||new Set(state.candidates.map(c=>c.pr)).size!==state.candidates.length) return blocked('INVALID_CANDIDATES');
 const c=state.candidates.find(c=>c.head===c.observedHead&&c.base===state.main&&c.checks===true&&c.approval===true&&c.threads===true&&c.authority===true);
 if(!c) return blocked('NO_ELIGIBLE_CANDIDATE');
 return {...blocked('SHADOW_NEXT'),pr:c.pr,expectedHead:c.head,expectedBase:c.base,method:'squash'};
}
