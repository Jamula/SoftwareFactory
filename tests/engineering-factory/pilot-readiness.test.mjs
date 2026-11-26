import test from 'node:test';import assert from 'node:assert/strict';import {pilotReadiness as check,evaluateSelfPilotCycles as cycles} from '../../tools/engineering-factory/pilot-readiness.mjs';
const p={repositoryId:1,pin:'a'.repeat(40),lineMin:97,branchMin:90,firstPilot:false};
const e={repositoryId:1,pin:p.pin,enrolled:true,stop:false,upstreamAccepted:true,review:true,coverageLine:97,coverageBranch:90,requiredChecks:true,quotaVerified:true,rollbackVerified:true,securityClear:true};
test('independent synthetic profiles',()=>{assert.equal(check(p,e).ready,true);assert.equal(check({...p,firstPilot:true},{...e,upstreamAccepted:false}).ready,true);assert.equal(check({...p,repositoryId:2},{...e,repositoryId:2}).liveActivation,false);});
test('deny invalid policy and incomplete readiness',()=>{for(const x of [null,[],Object.create(p),{...p,repositoryId:0},{...p,pin:'bad'},{...p,lineMin:null},{...p,lineMin:94},{...p,lineMin:101},{...p,branchMin:null},{...p,branchMin:89},{...p,branchMin:101},{...p,firstPilot:null}])assert.equal(check(x,e).reason,'POLICY_UNKNOWN');for(const x of [null,[],Object.create(e)])assert.equal(check(p,x).reason,'EVIDENCE_UNKNOWN');for(const x of [{stop:true},{enrolled:false},{repositoryId:2},{pin:'bad'},{upstreamAccepted:false},{review:false},{requiredChecks:false},{quotaVerified:false},{rollbackVerified:false},{securityClear:false},{coverageLine:null},{coverageLine:96},{coverageLine:101},{coverageBranch:null},{coverageBranch:89},{coverageBranch:101}])assert.equal(check(p,{...e,...x}).ready,false);});

test('independent pins, local thresholds and stop isolation',()=>{const p2={...p,repositoryId:2,pin:'b'.repeat(40),lineMin:95,branchMin:92};const e2={...e,repositoryId:2,pin:p2.pin,coverageLine:95,coverageBranch:92};assert.equal(check(p,e).ready,true);assert.equal(check(p2,e2).ready,true);assert.equal(check(p,e2).reason,'IDENTITY_OR_PIN');assert.equal(check(p2,e).reason,'IDENTITY_OR_PIN');assert.equal(check(p,{...e,stop:true}).reason,'STOPPED');assert.equal(check(p2,e2).ready,true);assert.equal(check(p2,{...e2,coverageBranch:91}).reason,'COVERAGE');assert.equal(check(p,{...e,coverageLine:96}).reason,'COVERAGE');assert.equal(check(p2,{...e2,stop:true}).reason,'STOPPED');assert.equal(check(p,e).ready,true);});


const cycle=(n,extra={})=>({repositoryId:1471342715,issue:n,pr:n+100,head:String(n).repeat(40),reviewedHead:String(n).repeat(40),reviewIndependent:true,checksPassed:true,securityClear:true,threadsResolved:true,lines:98,branches:95,mainVerified:true,costVerified:true,extraCost:0,humanInterventions:0,unauthorizedWrites:0,duplicateDispatches:0,startedAt:0,eligibleAt:10,mergedAt:10+n*1000,reviewFix:n===1,parallelCandidate:n===2,...extra});
const batch=()=>[cycle(1),cycle(2),cycle(3)];
test('self-pilot repeatability measures three independent synthetic cycles, never authorizes activation',()=>{
 assert.deepEqual(cycles(batch()),{shadow:true,liveActivation:false,accepted:false,reason:'SYNTHETIC_REPEATABILITY_ONLY',sampleCount:3,p50Ms:2000,p95Ms:3000});
 assert.equal(cycles([cycle(1,{reviewFix:false}),cycle(2),cycle(3)]).reason,'SCENARIO_MISSING');
 assert.equal(cycles([cycle(1),cycle(2,{parallelCandidate:false}),cycle(3)]).reason,'SCENARIO_MISSING');
 for(const x of [null,[],new Array(3),Array(51).fill(cycle(1))])assert.equal(cycles(x).reason,'CYCLE_INVENTORY_UNKNOWN');
});
test('repeatability rejects stale or wrong identity, duplicate work and unknown safety',()=>{
 const withFirst=change=>[cycle(1,change),cycle(2),cycle(3)];
 for(const change of [{repositoryId:2},{issue:0},{pr:0},{head:'bad'},{reviewedHead:'b'.repeat(40)}])assert.equal(cycles(withFirst(change)).reason,'IDENTITY_OR_REVIEW_UNKNOWN');
 assert.equal(cycles([null,cycle(2),cycle(3)]).reason,'IDENTITY_OR_REVIEW_UNKNOWN');
 for(const change of [{issue:2},{pr:102},{head:'2'.repeat(40),reviewedHead:'2'.repeat(40)}])assert.equal(cycles(withFirst(change)).reason,'DUPLICATE_CYCLE');
 for(const change of [{reviewIndependent:false},{checksPassed:false},{securityClear:false},{threadsResolved:false},{mainVerified:false},{costVerified:false},{extraCost:null},{extraCost:1},{humanInterventions:1},{unauthorizedWrites:1},{duplicateDispatches:1}])assert.equal(cycles(withFirst(change)).reason,'SAFETY_OR_COST_UNKNOWN');
 for(const change of [{lines:null},{lines:97},{lines:101},{branches:null},{branches:94},{branches:101}])assert.equal(cycles(withFirst(change)).reason,'COVERAGE');
 for(const change of [{startedAt:-1},{startedAt:11},{mergedAt:9},{reviewFix:null},{parallelCandidate:null}])assert.equal(cycles(withFirst(change)).reason,'TIMING_OR_SCENARIO_UNKNOWN');
});
