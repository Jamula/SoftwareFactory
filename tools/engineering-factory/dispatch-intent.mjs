const pos=x=>Number.isSafeInteger(x)&&x>0;
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const own=(x,k)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&k.every(p=>Object.hasOwn(Object.getOwnPropertyDescriptor(x,p)??{},'value'));
const deny=reason=>({shadow:true,liveDispatch:false,reason});
export function dispatchIntent(e){
 if(!own(e,['repositoryId','approvedRepositoryId','issue','head','generation','approved','stop','includedOnly','overageDisabled','capacity','leaseVerified','alreadyDispatched']))return deny('EVIDENCE_UNKNOWN');
 if(e.stop!==false)return deny('STOPPED');
 if(!pos(e.repositoryId)||e.repositoryId!==e.approvedRepositoryId||!pos(e.issue)||!sha(e.head)||!pos(e.generation)||e.approved!==true||e.leaseVerified!==true)return deny('SCOPE_OR_LEASE_UNKNOWN');
 if(e.includedOnly!==true||e.overageDisabled!==true||!pos(e.capacity))return deny('BUDGET_OR_CAPACITY_UNKNOWN');
 if(e.alreadyDispatched!==false)return deny('DUPLICATE_OR_UNKNOWN');
 return {...deny('DRY_RUN_ONLY'),key:[e.repositoryId,e.issue,e.head,e.generation].join(':'),repositoryId:e.repositoryId,issue:e.issue};
}
