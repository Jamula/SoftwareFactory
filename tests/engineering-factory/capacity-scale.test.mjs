import test from 'node:test';
import assert from 'node:assert/strict';
import {WORKER_GOAL, WORKER_LADDER, evaluateHostedWorkerLadder, recommendShadowScale} from '../../tools/engineering-factory/capacity-scale.mjs';
const receipt=()=>({receiptId:'hsr-scale-001',provider:'github-hosted-copilot',includedOnly:true,overageDisabled:true,hardStopEnforced:true,paidUsageMicros:0,observedMs:100});
const fixture=()=>({stop:false,repositoryId:1,approvedRepositoryId:1,independentEvidence:true,currentLimit:1,observedPeak:1,verifiedProviderLimit:12,repositoryLimitVerified:true,repositoryLimit:12,repositoryActive:0,comparabilityVerified:true,beforeCohort:'small-comparable',afterCohort:'small-comparable',beforeWindowMs:1000,afterWindowMs:1000,beforeAccepted:5,afterAccepted:8,qualityClear:true,mainHealthy:true,costVerified:true,extraCost:0,duplicateDispatches:0,unauthorizedWrites:0,budget:{stop:false,includedOnly:true,overageDisabled:true,authorityVerified:true,nowMs:100,observedMs:100,remaining:20,reserved:0,active:0,maxActive:12,unitsPerRun:1}});
const hostedFixture=()=>({...fixture(),environmentVerified:true,protectedEnvironment:'factory-copilot-pilot',isolatedWorktrees:true,overageDisabled:true,hardStopReceipt:receipt()});
test('advises only one synthetic tier at a time, never live dispatch',()=>{
  assert.deepEqual(WORKER_LADDER,[1,2,4,8,10,12]);
  assert.deepEqual(WORKER_GOAL,{min:10,max:12});
  assert.deepEqual(recommendShadowScale(fixture()),{shadow:true,liveDispatch:false,reason:'SHADOW_SCALE_RECOMMENDED',nextLimit:2});
  assert.equal(recommendShadowScale({...fixture(),environmentVerified:true,hardStopReceipt:receipt()}).nextLimit,2);
  assert.equal(recommendShadowScale({...fixture(),currentLimit:2,observedPeak:2}).nextLimit,4);
  assert.equal(recommendShadowScale({...fixture(),currentLimit:4,observedPeak:4}).nextLimit,8);
  assert.equal(recommendShadowScale({...fixture(),currentLimit:8,observedPeak:8}).nextLimit,10);
  assert.equal(recommendShadowScale({...fixture(),currentLimit:10,observedPeak:10}).nextLimit,12);
  assert.equal(recommendShadowScale({...fixture(),currentLimit:12,observedPeak:12}).reason,'LADDER_COMPLETE');
});
test('unknown or unsafe conditions block scaling',()=>{
  const cases=[
    [null,'STOPPED'],[{stop:true},'STOPPED'],
    [{environmentVerified:false},'ENVIRONMENT_UNVERIFIED'],
    ...[{repositoryId:0},{approvedRepositoryId:2},{independentEvidence:false},{currentLimit:3}].map(x=>[x,'SCOPE_UNKNOWN']),
    [{budget:{...fixture().budget,overageDisabled:false}},'BUDGET_UNKNOWN'],
    [{hardStopReceipt:{...receipt(),overageDisabled:false}},'OVERAGE_ENABLED'],
    [{hardStopReceipt:{...receipt(),hardStopEnforced:false}},'HARD_STOP_UNVERIFIED'],
    ...[{verifiedProviderLimit:0},{verifiedProviderLimit:3},{currentLimit:4,verifiedProviderLimit:2,budget:{...fixture().budget,maxActive:2}}].map(x=>[x,'PROVIDER_LIMIT_UNKNOWN']),
    ...[{observedPeak:null},{observedPeak:0},{beforeWindowMs:0},{afterWindowMs:2000},{beforeAccepted:null},{afterAccepted:null},{beforeAccepted:4},{afterAccepted:4}].map(x=>[x,'EXPERIMENT_EVIDENCE_UNKNOWN']),
    ...[{qualityClear:false},{mainHealthy:false},{costVerified:false},{extraCost:1},{duplicateDispatches:1},{unauthorizedWrites:1}].map(x=>[x,'SAFETY_OR_COST_UNKNOWN']),
    ...[{repositoryLimitVerified:false},{repositoryLimit:0},{repositoryActive:null},{repositoryActive:1},{repositoryActive:2,budget:{...fixture().budget,active:2}},{currentLimit:4,repositoryLimit:2}].map(x=>[x,'REPOSITORY_CAPACITY_UNKNOWN']),
    ...[{comparabilityVerified:false},{beforeCohort:null},{beforeCohort:'!'},{afterCohort:'different'}].map(x=>[x,'COHORT_UNKNOWN']),
    [{afterAccepted:5},'NO_MEASURED_GAIN'],
    [{repositoryLimit:1},'CAPACITY_INSUFFICIENT'],
    [{verifiedProviderLimit:1,budget:{...fixture().budget,maxActive:1}},'CAPACITY_INSUFFICIENT'],
    [{budget:{...fixture().budget,remaining:1}},'CAPACITY_INSUFFICIENT']
  ];
  for(const [change,reason] of cases)assert.deepEqual(recommendShadowScale(change===null?null:{...fixture(),...change}),{shadow:true,liveDispatch:false,reason,nextLimit:null});
});

test('does not credit workers from other repositories toward the next tier',()=>{
  const shared={...fixture(),currentLimit:2,observedPeak:2,verifiedProviderLimit:4,
    repositoryLimit:4,repositoryActive:0,budget:{...fixture().budget,maxActive:4,active:2}};
  assert.equal(recommendShadowScale(shared).reason,'CAPACITY_INSUFFICIENT');
  assert.equal(recommendShadowScale({...shared,repositoryActive:2}).nextLimit,4);
});

test('evaluates hosted 1->2->4->8->10->12 ladder with actual max workers and shortfall against 10-12 goal',()=>{
  const full=evaluateHostedWorkerLadder(hostedFixture());
  assert.deepEqual(full,{
    shadow:true,
    liveDispatch:false,
    reason:'SHADOW_SCALE_RECOMMENDED',
    nextLimit:2,
    actualMaxWorkers:12,
    verifiedCapacityCeiling:12,
    goalMinWorkers:10,
    goalMaxWorkers:12,
    shortfallMin:0,
    shortfallMax:0,
    goalMet:true
  });
  assert.equal(Object.isFrozen(full),true);
  // Non-ladder verified quota ceiling (e.g. 6 remaining units) caps actualMaxWorkers to ladder tier 4, reporting shortfall 6/8.
  const proPlus=evaluateHostedWorkerLadder({...hostedFixture(),currentLimit:2,observedPeak:2,
    verifiedProviderLimit:8,repositoryLimit:8,budget:{...hostedFixture().budget,maxActive:8,remaining:6}});
  assert.equal(proPlus.reason,'SHADOW_SCALE_RECOMMENDED');
  assert.equal(proPlus.nextLimit,4);
  assert.equal(proPlus.verifiedCapacityCeiling,6);
  assert.equal(proPlus.actualMaxWorkers,4);
  assert.equal(proPlus.shortfallMin,6);
  assert.equal(proPlus.shortfallMax,8);
  assert.equal(proPlus.goalMet,false);
  // At ceiling 4 with all 4 workers active (budget available = 0), blocks 4->8 while preserving actualMaxWorkers=4 and shortfall 6/8.
  const saturated4=evaluateHostedWorkerLadder({...hostedFixture(),currentLimit:4,observedPeak:4,
    verifiedProviderLimit:4,repositoryLimit:4,repositoryActive:4,
    budget:{...hostedFixture().budget,maxActive:4,active:4,remaining:4}});
  assert.equal(saturated4.reason,'CAPACITY_INSUFFICIENT');
  assert.equal(saturated4.nextLimit,null);
  assert.equal(saturated4.actualMaxWorkers,4);
  assert.equal(saturated4.shortfallMin,6);
  assert.equal(saturated4.shortfallMax,8);
  assert.equal(saturated4.goalMet,false);
  // Verified ceiling of 10 meets 10-worker minimum (shortfallMin=0) while reporting shortfallMax=2 against 12, blocking 10->12.
  const tenCap=evaluateHostedWorkerLadder({...hostedFixture(),currentLimit:10,observedPeak:10,
    verifiedProviderLimit:10,repositoryLimit:12,budget:{...hostedFixture().budget,maxActive:10,remaining:10}});
  assert.equal(tenCap.reason,'CAPACITY_INSUFFICIENT');
  assert.equal(tenCap.nextLimit,null);
  assert.equal(tenCap.actualMaxWorkers,10);
  assert.equal(tenCap.shortfallMin,0);
  assert.equal(tenCap.shortfallMax,2);
  assert.equal(tenCap.goalMet,true);
  // Zero remaining units yields ceiling=0, actualMaxWorkers=0, shortfall 10/12.
  const zeroRemaining=evaluateHostedWorkerLadder({...hostedFixture(),budget:{...hostedFixture().budget,remaining:0}});
  assert.equal(zeroRemaining.reason,'CAPACITY_INSUFFICIENT');
  assert.equal(zeroRemaining.actualMaxWorkers,0);
  assert.equal(zeroRemaining.shortfallMin,10);
  assert.equal(zeroRemaining.shortfallMax,12);
  // No measured gain and ladder complete still report verified max workers.
  const noGain=evaluateHostedWorkerLadder({...hostedFixture(),afterAccepted:5,
    verifiedProviderLimit:8,budget:{...hostedFixture().budget,maxActive:8}});
  assert.equal(noGain.reason,'NO_MEASURED_GAIN');
  assert.equal(noGain.actualMaxWorkers,8);
  assert.equal(noGain.shortfallMin,2);
  assert.equal(noGain.shortfallMax,4);
  const done=evaluateHostedWorkerLadder({...hostedFixture(),currentLimit:12,observedPeak:12});
  assert.equal(done.reason,'LADDER_COMPLETE');
  assert.equal(done.actualMaxWorkers,12);
  assert.equal(done.shortfallMax,0);
});

test('hosted worker ladder blocks fail-closed on missing environment, overage enabled, unknown quota, or invalid hard-stop receipt',()=>{
  const blockedCases=[
    [null,'STOPPED'],
    [new Proxy(hostedFixture(),{}),'STOPPED'],
    [{stop:true},'STOPPED'],
    [{environmentVerified:false},'ENVIRONMENT_UNVERIFIED'],
    [{protectedEnvironment:'INVALID_ENV'},'ENVIRONMENT_UNVERIFIED'],
    [{isolatedWorktrees:false},'ENVIRONMENT_UNVERIFIED'],
    [{overageDisabled:false},'OVERAGE_ENABLED'],
    [{budget:{...hostedFixture().budget,overageDisabled:false}},'OVERAGE_ENABLED'],
    [{hardStopReceipt:{...receipt(),overageDisabled:false}},'OVERAGE_ENABLED'],
    [{repositoryId:0},'SCOPE_UNKNOWN'],
    [{currentLimit:6},'SCOPE_UNKNOWN'],
    [{budget:null},'QUOTA_UNKNOWN'],
    [{budget:{...hostedFixture().budget,includedOnly:false}},'QUOTA_UNKNOWN'],
    [{budget:{...hostedFixture().budget,overageDisabled:null}},'QUOTA_UNKNOWN'],
    [{budget:{...hostedFixture().budget,authorityVerified:false}},'QUOTA_UNKNOWN'],
    [{budget:{...hostedFixture().budget,nowMs:999999}},'STALE_QUOTA'],
    [{budget:{...hostedFixture().budget,unitsPerRun:0}},'INVALID_QUOTA'],
    [{hardStopReceipt:null},'HARD_STOP_UNVERIFIED'],
    [{hardStopReceipt:{...receipt(),paidUsageMicros:1}},'PAID_USAGE_NONZERO'],
    [{hardStopReceipt:{...receipt(),observedMs:200}},'STALE_HARD_STOP_RECEIPT'],
    [{verifiedProviderLimit:4},'PROVIDER_LIMIT_UNKNOWN'],
    [{repositoryLimitVerified:false},'REPOSITORY_CAPACITY_UNKNOWN'],
    [{comparabilityVerified:false},'COHORT_UNKNOWN'],
    [{observedPeak:0},'EXPERIMENT_EVIDENCE_UNKNOWN'],
    [{extraCost:1},'SAFETY_OR_COST_UNKNOWN']
  ];
  for(const [change,reason] of blockedCases){
    const input=change===null||change instanceof Object&&Object.keys(change).length===Object.keys(hostedFixture()).length?change:{...hostedFixture(),...change};
    const out=evaluateHostedWorkerLadder(input);
    assert.deepEqual(out,{
      shadow:true,
      liveDispatch:false,
      reason,
      nextLimit:null,
      actualMaxWorkers:0,
      verifiedCapacityCeiling:0,
      goalMinWorkers:10,
      goalMaxWorkers:12,
      shortfallMin:10,
      shortfallMax:12,
      goalMet:false
    });
  }
});
