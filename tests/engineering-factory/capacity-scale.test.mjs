import test from 'node:test';
import assert from 'node:assert/strict';
import {WORKER_GOAL, WORKER_LADDER, evaluateHostedWorkerLadder, recommendShadowScale} from '../../tools/engineering-factory/capacity-scale.mjs';
const receipt = () => ({receiptId: 'hsr-scale-001', provider: 'github-hosted-copilot', includedOnly: true, overageDisabled: true, hardStopEnforced: true, paidUsageMicros: 0, observedMs: 100});
const baseFixture = () => ({stop: false, repositoryId: 1, approvedRepositoryId: 1, independentEvidence: true, currentLimit: 1, observedPeak: 1, verifiedProviderLimit: 12, repositoryLimitVerified: true, repositoryLimit: 12, repositoryActive: 0, qualityClear: true, mainHealthy: true, costVerified: true, extraCost: 0, duplicateDispatches: 0, unauthorizedWrites: 0, budget: {stop: false, includedOnly: true, overageDisabled: true, authorityVerified: true, nowMs: 100, observedMs: 100, remaining: 20, reserved: 0, active: 0, maxActive: 12, unitsPerRun: 1}});
const fixture = () => ({...baseFixture(), comparabilityVerified: true, beforeCohort: 'small-comparable', afterCohort: 'small-comparable', beforeWindowMs: 1000, afterWindowMs: 1000, beforeAccepted: 5, afterAccepted: 8});
const hostedFixture = () => ({...baseFixture(), environmentVerified: true, protectedEnvironment: 'factory-copilot-pilot', isolatedWorktrees: true, overageDisabled: true, hardStopReceipt: receipt()});
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
    actualMaxWorkers:1,
    verifiedCapacityCeiling:12,
    goalMinWorkers:10,
    goalMaxWorkers:12,
    shortfallMin:9,
    shortfallMax:11,
    goalMet:false
  });
  assert.equal(Object.isFrozen(full),true);
  // Observed peak of 2 reports actualMaxWorkers=2 and shortfall 8/10 while keeping prospective ceiling=6 in verifiedCapacityCeiling.
  const proPlus=evaluateHostedWorkerLadder({...hostedFixture(),currentLimit:2,observedPeak:2,
    verifiedProviderLimit:8,repositoryLimit:8,budget:{...hostedFixture().budget,maxActive:8,remaining:6}});
  assert.equal(proPlus.reason,'SHADOW_SCALE_RECOMMENDED');
  assert.equal(proPlus.nextLimit,4);
  assert.equal(proPlus.verifiedCapacityCeiling,6);
  assert.equal(proPlus.actualMaxWorkers,2);
  assert.equal(proPlus.shortfallMin,8);
  assert.equal(proPlus.shortfallMax,10);
  assert.equal(proPlus.goalMet,false);
  // At ceiling 4 with all 4 workers active (budget available = 0), blocks 4->8 while reporting observed actualMaxWorkers=4 and shortfall 6/8.
  const saturated4=evaluateHostedWorkerLadder({...hostedFixture(),currentLimit:4,observedPeak:4,
    verifiedProviderLimit:4,repositoryLimit:4,repositoryActive:4,
    budget:{...hostedFixture().budget,maxActive:4,active:4,remaining:4}});
  assert.equal(saturated4.reason,'CAPACITY_INSUFFICIENT');
  assert.equal(saturated4.nextLimit,null);
  assert.equal(saturated4.actualMaxWorkers,4);
  assert.equal(saturated4.shortfallMin,6);
  assert.equal(saturated4.shortfallMax,8);
  assert.equal(saturated4.goalMet,false);
  // Observed peak of 10 meets 10-worker minimum (shortfallMin=0) while reporting shortfallMax=2 against 12, blocking 10->12.
  const tenCap=evaluateHostedWorkerLadder({...hostedFixture(),currentLimit:10,observedPeak:10,
    verifiedProviderLimit:10,repositoryLimit:12,budget:{...hostedFixture().budget,maxActive:10,remaining:10}});
  assert.equal(tenCap.reason,'CAPACITY_INSUFFICIENT');
  assert.equal(tenCap.nextLimit,null);
  assert.equal(tenCap.actualMaxWorkers,10);
  assert.equal(tenCap.shortfallMin,0);
  assert.equal(tenCap.shortfallMax,2);
  assert.equal(tenCap.goalMet,true);
  // Zero remaining units yields verifiedCapacityCeiling=0, blocking 1->2 while reporting observed actualMaxWorkers=1 (shortfall 9/11).
  const zeroRemaining=evaluateHostedWorkerLadder({...hostedFixture(),budget:{...hostedFixture().budget,remaining:0}});
  assert.equal(zeroRemaining.reason,'CAPACITY_INSUFFICIENT');
  assert.equal(zeroRemaining.verifiedCapacityCeiling,0);
  assert.equal(zeroRemaining.actualMaxWorkers,1);
  assert.equal(zeroRemaining.shortfallMin,9);
  assert.equal(zeroRemaining.shortfallMax,11);
  // Hosted M01 ladder does not require M02 comparative-throughput cohorts or >=5 accepted gains when safety/capacity pass,
  // while recommendShadowScale retains comparative cohort and measured-gain gates.
  const m01NonComparative = {...hostedFixture(), currentLimit: 8, observedPeak: 8,
    comparabilityVerified: false, beforeAccepted: 2, afterAccepted: 2,
    verifiedProviderLimit: 10, budget: {...hostedFixture().budget, maxActive: 10}};
  const eightStep = evaluateHostedWorkerLadder(m01NonComparative);
  assert.equal(eightStep.reason, 'SHADOW_SCALE_RECOMMENDED');
  assert.equal(eightStep.nextLimit, 10);
  assert.equal(eightStep.actualMaxWorkers, 8);
  assert.equal(eightStep.shortfallMin, 2);
  assert.equal(eightStep.shortfallMax, 4);
  assert.equal(eightStep.goalMet, false);
  assert.equal(recommendShadowScale(hostedFixture()).reason, 'COHORT_UNKNOWN');
  assert.equal(recommendShadowScale({...fixture(), currentLimit: 8, observedPeak: 8, afterAccepted: 5}).reason, 'NO_MEASURED_GAIN');
  const done = evaluateHostedWorkerLadder({...hostedFixture(), currentLimit: 12, observedPeak: 12});
  assert.equal(done.reason, 'LADDER_COMPLETE');
  assert.equal(done.actualMaxWorkers, 12);
  assert.equal(done.shortfallMax, 0);
  assert.equal(done.goalMet, true);
});

test('hosted worker ladder blocks fail-closed on missing environment, overage enabled, unknown quota, or invalid hard-stop receipt', () => {
  const proxyHosted = new Proxy(hostedFixture(), {});
  const getterPeakHosted = Object.defineProperty(hostedFixture(), 'observedPeak', {
    get: () => 1,
    enumerable: true
  });
  const blockedCases = [
    [null, 'STOPPED'],
    [proxyHosted, 'STOPPED'],
    [{stop: true}, 'STOPPED'],
    [{environmentVerified: false}, 'ENVIRONMENT_UNVERIFIED'],
    [{protectedEnvironment: 'INVALID_ENV'}, 'ENVIRONMENT_UNVERIFIED'],
    [{isolatedWorktrees: false}, 'ENVIRONMENT_UNVERIFIED'],
    [{overageDisabled: false}, 'OVERAGE_ENABLED'],
    [{budget: {...hostedFixture().budget, overageDisabled: false}}, 'OVERAGE_ENABLED'],
    [{hardStopReceipt: {...receipt(), overageDisabled: false}}, 'OVERAGE_ENABLED'],
    [{repositoryId: 0}, 'SCOPE_UNKNOWN'],
    [{currentLimit: 6}, 'SCOPE_UNKNOWN'],
    [{budget: null}, 'QUOTA_UNKNOWN'],
    [{budget: {...hostedFixture().budget, includedOnly: false}}, 'QUOTA_UNKNOWN'],
    [{budget: {...hostedFixture().budget, overageDisabled: null}}, 'QUOTA_UNKNOWN'],
    [{budget: {...hostedFixture().budget, authorityVerified: false}}, 'QUOTA_UNKNOWN'],
    [{budget: {...hostedFixture().budget, nowMs: 999999}}, 'STALE_QUOTA'],
    [{budget: {...hostedFixture().budget, unitsPerRun: 0}}, 'INVALID_QUOTA'],
    [{hardStopReceipt: null}, 'HARD_STOP_UNVERIFIED'],
    [{hardStopReceipt: {...receipt(), paidUsageMicros: 1}}, 'PAID_USAGE_NONZERO'],
    [{hardStopReceipt: {...receipt(), observedMs: 200}}, 'STALE_HARD_STOP_RECEIPT'],
    [{verifiedProviderLimit: 4}, 'PROVIDER_LIMIT_UNKNOWN'],
    [{repositoryLimitVerified: false}, 'REPOSITORY_CAPACITY_UNKNOWN'],
    [{observedPeak: null}, 'OBSERVED_WORKERS_UNKNOWN'],
    [{observedPeak: 0}, 'OBSERVED_WORKERS_UNKNOWN'],
    [{observedPeak: 2}, 'OBSERVED_WORKERS_UNKNOWN'],
    [getterPeakHosted, 'OBSERVED_WORKERS_UNKNOWN'],
    [{qualityClear: false}, 'SAFETY_OR_COST_UNKNOWN'],
    [{mainHealthy: false}, 'SAFETY_OR_COST_UNKNOWN'],
    [{costVerified: false}, 'SAFETY_OR_COST_UNKNOWN'],
    [{extraCost: 1}, 'SAFETY_OR_COST_UNKNOWN'],
    [{duplicateDispatches: 1}, 'SAFETY_OR_COST_UNKNOWN'],
    [{unauthorizedWrites: 1}, 'SAFETY_OR_COST_UNKNOWN']
  ];
  for (const [change, reason] of blockedCases) {
    const isDirectInput = change === null || change === proxyHosted || change === getterPeakHosted;
    const input = isDirectInput ? change : {...hostedFixture(), ...change};
    const out = evaluateHostedWorkerLadder(input);
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
