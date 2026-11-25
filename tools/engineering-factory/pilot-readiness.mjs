const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const id=x=>Number.isSafeInteger(x)&&x>0;
const own=(x,k)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&k.every(p=>Object.hasOwn(Object.getOwnPropertyDescriptor(x,p)??{},'value'));
const deny=reason=>({shadow:true,ready:false,liveActivation:false,reason});
export function pilotReadiness(policy,e){
 if(!own(policy,['repositoryId','pin','lineMin','branchMin','firstPilot'])||!id(policy.repositoryId)||!sha(policy.pin)||!Number.isFinite(policy.lineMin)||policy.lineMin<95||policy.lineMin>100||!Number.isFinite(policy.branchMin)||policy.branchMin<90||policy.branchMin>100||typeof policy.firstPilot!=='boolean')return deny('POLICY_UNKNOWN');
 if(!own(e,['repositoryId','pin','enrolled','stop','upstreamAccepted','review','coverageLine','coverageBranch','requiredChecks','quotaVerified','rollbackVerified','securityClear']))return deny('EVIDENCE_UNKNOWN');
 if(e.stop!==false||e.enrolled!==true)return deny('STOPPED');
 if(e.repositoryId!==policy.repositoryId||e.pin!==policy.pin)return deny('IDENTITY_OR_PIN');
 if(!policy.firstPilot&&e.upstreamAccepted!==true)return deny('UPSTREAM_BLOCKED');
 if(e.review!==true||e.requiredChecks!==true||e.quotaVerified!==true||e.rollbackVerified!==true||e.securityClear!==true)return deny('GATES_UNKNOWN');
 if(!Number.isFinite(e.coverageLine)||e.coverageLine<policy.lineMin||e.coverageLine>100||!Number.isFinite(e.coverageBranch)||e.coverageBranch<policy.branchMin||e.coverageBranch>100)return deny('COVERAGE');
 return {shadow:true,ready:true,liveActivation:false,reason:'SYNTHETIC_READY_ONLY'};
}
