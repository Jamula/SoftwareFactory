import test from 'node:test';
import assert from 'node:assert/strict';
import {recommendShadowScale} from '../../tools/engineering-factory/capacity-scale.mjs';
const fixture=()=>({stop:false,repositoryId:1,approvedRepositoryId:1,independentEvidence:true,currentLimit:1,observedPeak:1,verifiedProviderLimit:12,repositoryLimitVerified:true,repositoryLimit:12,repositoryActive:0,comparabilityVerified:true,beforeCohort:'small-comparable',afterCohort:'small-comparable',beforeWindowMs:1000,afterWindowMs:1000,beforeAccepted:5,afterAccepted:8,qualityClear:true,mainHealthy:true,costVerified:true,extraCost:0,duplicateDispatches:0,unauthorizedWrites:0,budget:{stop:false,includedOnly:true,overageDisabled:true,authorityVerified:true,nowMs:100,observedMs:100,remaining:20,reserved:0,active:0,maxActive:12,unitsPerRun:1}});
test('advises only one synthetic tier at a time, never live dispatch',()=>{
  assert.deepEqual(recommendShadowScale(fixture()),{shadow:true,liveDispatch:false,reason:'SHADOW_SCALE_RECOMMENDED',nextLimit:2});
  assert.equal(recommendShadowScale({...fixture(),currentLimit:2,observedPeak:2}).nextLimit,4);
  assert.equal(recommendShadowScale({...fixture(),currentLimit:4,observedPeak:4}).nextLimit,8);
  assert.equal(recommendShadowScale({...fixture(),currentLimit:8,observedPeak:8}).nextLimit,10);
  assert.equal(recommendShadowScale({...fixture(),currentLimit:10,observedPeak:10}).nextLimit,12);
  assert.equal(recommendShadowScale({...fixture(),currentLimit:12,observedPeak:12}).reason,'LADDER_COMPLETE');
});
test('unknown or unsafe conditions block scaling',()=>{
  const cases=[
    [null,'STOPPED'],[{stop:true},'STOPPED'],
    ...[{repositoryId:0},{approvedRepositoryId:2},{independentEvidence:false},{currentLimit:3}].map(x=>[x,'SCOPE_UNKNOWN']),
    [{budget:{...fixture().budget,overageDisabled:false}},'BUDGET_UNKNOWN'],
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
