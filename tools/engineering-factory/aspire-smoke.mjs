import assert from 'node:assert/strict';
import {evaluate} from './core.mjs';

const policy = {
  version:1, repository:'synthetic/example', defaultBranch:'main',
  mergeMethod:'squash', mode:'disabled', killSwitch:true,
  checks:[{name:'synthetic-validation',appId:1}],
  reviewers:['synthetic-reviewer'], coverage:{line:95,branch:90},
  owners:[{prefix:'src',owner:'synthetic-owner'}],
  maxActive:1, creditLimit:1, riskClasses:['low']
};
const result = evaluate(policy,{policySource:'trusted-default-branch',repository:policy.repository});
assert.deepEqual(result,{state:'blocked',reason:'STOPPED',shadow:true});
console.log(JSON.stringify({scenario:'local-synthetic-stop',state:result.state,reason:result.reason,shadow:result.shadow}));
