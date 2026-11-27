import test from 'node:test';import assert from 'node:assert/strict';import {coverageEvidence as check,coverageFromNodeSummary as fromNode,verifyCandidateGateReceipt as verifyReceipt} from '../../tools/engineering-factory/coverage-evidence.mjs';
const h='a'.repeat(40),r={component:'core',head:h,lines:98,lineTotal:100,branches:19,branchTotal:20};
test('threshold and weighted counts',()=>{assert.equal(check(h,['core'],[r]).valid,true);assert.equal(check(h,['core'],[{...r,lines:97}]).reason,'COMPONENT_BELOW_TARGET');assert.equal(check(h,['core'],[{...r,branches:18}]).reason,'COMPONENT_BELOW_TARGET');assert.deepEqual(check(h,['core','other'],[r,{...r,component:'other',lines:200,lineTotal:200}]),{shadow:true,valid:true,reason:'COUNTS_ONLY',lines:298,lineTotal:300,branches:38,branchTotal:40});});
test('deny incomplete or invalid reports',()=>{const holey=new Array(1);holey.extra=1;for(const [head,names,rows] of [['bad',['core'],[r]],[h,null,[r]],[h,[],[]],[h,['bad name'],[r]],[h,['core','core'],[r,r]],[h,['core'],null],[h,['core'],[]],[h,new Array(1),[r]],[h,holey,[r]],[h,Array(251).fill('core'),[]],[h,['core','other'],[r,r]]])assert.equal(check(head,names,rows).valid,false);for(const x of [null,[],Object.create(r),{component:'core'},{...r,component:'other'},{...r,head:'b'.repeat(40)},{...r,lines:-1},{...r,lines:101},{...r,lineTotal:0},{...r,lines:1.5},{...r,lineTotal:100000001},{...r,branches:10.5},{...r,branchTotal:0},{...r,lines:97},{...r,branches:18}])assert.equal(check(h,['core'],[x]).valid,false);});

test('reject getters and custom array behavior without invoking them',()=>{let calls=0;const bad=()=>{calls++;throw Error('unexpected read');};const names=['core'],rows=[r];Object.defineProperty(names,0,{get:bad});Object.defineProperty(rows,0,{get:bad});assert.equal(check(h,names,[r]).reason,'INVENTORY_UNKNOWN');assert.equal(check(h,['core'],rows).reason,'INVENTORY_UNKNOWN');const stale=[{...r,head:'b'.repeat(40)}];Object.defineProperty(stale,Symbol.iterator,{value:function*(){calls++;yield r;}});assert.equal(check(h,['core'],stale).reason,'INVENTORY_UNKNOWN');const overridden=['core'];Object.defineProperty(overridden,'every',{value:bad});assert.equal(check(h,overridden,[r]).reason,'INVENTORY_UNKNOWN');const inherited=Object.setPrototypeOf([r],Object.create(Array.prototype));assert.equal(check(h,['core'],inherited).reason,'INVENTORY_UNKNOWN');assert.equal(calls,0);});

test('reject proxy evidence before executing any traps',()=>{let calls=0;const trap=()=>{calls++;throw Error('unexpected proxy trap');};const handler={get:trap,getOwnPropertyDescriptor:trap,ownKeys:trap,getPrototypeOf:trap};assert.equal(check(h,new Proxy(['core'],handler),[r]).reason,'INVENTORY_UNKNOWN');assert.equal(check(h,['core'],new Proxy([r],handler)).reason,'INVENTORY_UNKNOWN');assert.equal(check(h,['core'],[new Proxy(r,handler)]).reason,'INVALID_REPORT');const revoked=Proxy.revocable([r],{});revoked.revoke();assert.equal(check(h,['core'],revoked.proxy).reason,'INVENTORY_UNKNOWN');assert.equal(calls,0);});


test('actual node summary counts bind to independent inventory and exact head',()=>{
 const f={component:'core',coveredLineCount:98,totalLineCount:100,coveredBranchCount:19,totalBranchCount:20};
 const second={...f,component:'runner',coveredLineCount:100};
 const v=fromNode(h,['core','runner'],[f,second]);
 assert.equal(v.valid,true);assert.equal(v.head,h);assert.equal(v.lines,198);assert.equal(v.lineTotal,200);
 assert.equal(v.components[0].head,h);assert.equal(v.branches,38);
 for(const x of [null,[],new Array(1)])assert.equal(fromNode(h,['core'],x).reason,'INVENTORY_UNKNOWN');
 for(const x of [null,{component:'core'},Object.create(f)])assert.equal(fromNode(h,['core'],[x]).reason,'INVALID_REPORT');
 assert.equal(fromNode(h,['core','runner'],[f]).valid,false);
 assert.equal(fromNode(h,['core'],[f,second]).valid,false);
 assert.equal(fromNode(h,['core','runner'],[f,f]).valid,false);
 assert.equal(fromNode(h,['core'],[{...f,coveredBranchCount:18}]).reason,'COMPONENT_BELOW_TARGET');
 assert.equal(fromNode(h,['core'],[{...f,totalBranchCount:0,coveredBranchCount:0}]).reason,'INVALID_REPORT');
});

test('consumer and repository policies enforce 98/95 factory floor and >=95/90 or stricter consumer gates without lowering',()=>{
 const consumer95={component:'core',head:h,lines:95,lineTotal:100,branches:18,branchTotal:20};
 const stricter97={component:'core',head:h,lines:97,lineTotal:100,branches:18,branchTotal:20};
 assert.equal(check(h,['core'],[r],{}).valid,true);
 assert.equal(check(h,['core'],[consumer95],{}).reason,'COMPONENT_BELOW_TARGET');
 assert.equal(check(h,['core'],[consumer95],{repository:'example/family-tree'}).valid,true);
 assert.equal(check(h,['core'],[{...consumer95,lines:94}],{repository:'example/family-tree'}).reason,'COMPONENT_BELOW_TARGET');
 assert.equal(check(h,['core'],[{...consumer95,branches:17}],{repository:'example/family-tree'}).reason,'COMPONENT_BELOW_TARGET');
 const spellbookPolicy={repository:'example/spellbook',lineMin:97,branchMin:90,existingLineMin:97,existingBranchMin:90};
 assert.equal(check(h,['core'],[stricter97],spellbookPolicy).valid,true);
 assert.equal(check(h,['core'],[consumer95],spellbookPolicy).reason,'COMPONENT_BELOW_TARGET');
 assert.equal(fromNode(h,['core'],[{component:'core',coveredLineCount:97,totalLineCount:100,coveredBranchCount:18,totalBranchCount:20}],spellbookPolicy).valid,true);

 let calls=0;
 const getterPolicy={};
 Object.defineProperty(getterPolicy,'lineMin',{get(){calls++;return 98;}});
 const symPolicy={[Symbol('x')]:1};
 for(const badPolicy of [
  null,[],Object.create({}),new Proxy({},{get(){calls++;return 98;}}),getterPolicy,symPolicy,{unknown:true},
  {repository:''},{repository:'bad'},{repository:'a/../b'},
  {repository:'Jamula/SoftwareFactory',lineMin:97},{repository:'Jamula/SoftwareFactory',branchMin:94},
  {lineMin:97},{branchMin:94},{lineMin:101},{branchMin:NaN},
  {repository:'example/family-tree',lineMin:94},{repository:'example/family-tree',branchMin:89},
  {repository:'example/spellbook',existingLineMin:94},{repository:'example/spellbook',existingBranchMin:89},
  {repository:'example/spellbook',existingLineMin:97,lineMin:96},
  {repository:'example/spellbook',existingBranchMin:92,branchMin:90}
 ])assert.equal(check(h,['core'],[r],badPolicy).reason,'INVALID_POLICY');
 assert.equal(calls,0);
});

test('branchless components require an exact-head reviewed justification and still enforce line targets',()=>{
 const zero={component:'schema',head:h,lines:50,lineTotal:50,branches:0,branchTotal:0};
 const entry={component:'schema',head:h,reviewedBy:'independent-reviewer',reason:'pure constant schema definition'};
 assert.equal(check(h,['schema'],[zero],{}).reason,'BRANCHLESS_UNJUSTIFIED');
 assert.equal(check(h,['schema'],[{...zero,branches:1}],{branchless:[entry]}).reason,'INVALID_REPORT');
 assert.deepEqual(check(h,['core','schema'],[r,zero],{branchless:[entry]}),
  {shadow:true,valid:true,reason:'COUNTS_ONLY',lines:148,lineTotal:150,branches:19,branchTotal:20});
 assert.equal(check(h,['schema'],[{...zero,lines:48}],{branchless:[entry]}).reason,'COMPONENT_BELOW_TARGET');
 assert.equal(check(h,['schema'],[zero],{branchless:[{...entry,head:'b'.repeat(40)}]}).reason,'BRANCHLESS_UNJUSTIFIED');
 assert.equal(check(h,['core'],[r],{branchless:[entry]}).reason,'BRANCHLESS_UNJUSTIFIED');
 assert.equal(check(h,['core'],[r],{branchless:[{...entry,component:'core'}]}).reason,'BRANCHLESS_UNJUSTIFIED');
 const nodeSummary=fromNode(h,['schema'],[{component:'schema',coveredLineCount:50,totalLineCount:50,coveredBranchCount:0,totalBranchCount:0}],{branchless:[entry]});
 assert.equal(nodeSummary.valid,true);
 assert.equal(nodeSummary.branchTotal,0);

 for(const badBranchless of [
  null,new Array(1),[null],[{...entry,extra:1}],[{...entry,component:'BAD'}],
  [{...entry,head:'short'}],[{...entry,reviewedBy:' bad'}],[{...entry,reason:'short'}],
  [{...entry,reason:123}],[{...entry,reason:'x'.repeat(241)}],[{...entry,reason:'valid len\ncontrol'}]
 ])assert.equal(check(h,['schema'],[zero],{branchless:badBranchless}).reason,'INVALID_POLICY');
 assert.equal(check(h,['core','schema'],[r,zero],{branchless:[entry,entry]}).reason,'INVALID_POLICY');
});

test('verifyCandidateGateReceipt reconciles rulesets, fork PRs, merge_group checks, CodeQL, review summaries, and coverage>=98',()=>{
 const mg='c'.repeat(40);
 const contexts=['build-test','upload-coverage-javascript','windows-aspire-runtime'];
 const baseReceipt=()=>({
  repository:'Jamula/SoftwareFactory',
  repositoryId:1471342715,
  branch:'main',
  headRepository:'Jamula/SoftwareFactory',
  isFork:false,
  head:h,
  mergeGroupHead:mg,
  ruleset:{
   strict_required_status_checks_policy:true,
   required_status_checks:contexts.map(context=>({context,integration_id:15368})),
   minimum_coverage:98,
   max_coverage_drop:0,
   required_approving_review_count:0,
   required_review_thread_resolution:true,
   allowed_merge_methods:['squash'],
   merge_queue_grouping:'ALLGREEN',
   bypass_actors:0,
   secret_scanning_required:true,
   code_scanning_tools:[
    {tool:'CodeQL',security_alerts_threshold:'medium_or_higher',alerts_threshold:'errors_and_warnings'}
   ]
  },
  pullChecks:[
   ...contexts.map(name=>({name,head:h,appId:15368,status:'completed',conclusion:'success'})),
   {name:'pinned-synthetic-replay',head:h,appId:15368,status:'completed',conclusion:'success'}
  ],
  mergeGroupChecks:contexts.map(name=>({name,head:mg,appId:15368,event:'merge_group',status:'completed',conclusion:'success'})),
  codeScanning:{tool:'CodeQL',head:h,status:'completed',conclusion:'success',openAlerts:0},
  secretScanningClear:true,
  threadsResolved:true,
  trustedReviewers:['copilot-pull-request-reviewer[bot]','human-reviewer'],
  review:{
   head:h,
   reviewer:'copilot-pull-request-reviewer[bot]',
   author:'contributor',
   agent:'coding-agent',
   state:'COMMENTED',
   independent:true,
   summaryDisposition:'clear',
   unresolvedSummaryFindings:0,
   blockingReviewCount:0
  },
  expectedComponents:['core'],
  coverageReports:[r]
 });

 const ok=verifyReceipt(baseReceipt());
 assert.deepEqual(ok,{shadow:true,valid:true,liveMerge:false,reason:'CANDIDATE_GATES_VERIFIED',head:h,mergeGroupHead:mg});
 assert.equal(Object.isFrozen(ok),true);
 const approvedReceipt=baseReceipt();
 approvedReceipt.review={...approvedReceipt.review,reviewer:'human-reviewer',state:'APPROVED'};
 assert.equal(verifyReceipt(approvedReceipt).valid,true);

 for(const patch of [
  {repository:'example/other'},{repositoryId:1},{branch:'dev'},{headRepository:'bad'},
  {isFork:'no'},{head:'bad'},{mergeGroupHead:'bad'},{secretScanningClear:'yes'},{threadsResolved:null},
  {trustedReviewers:null},{trustedReviewers:[]},{trustedReviewers:[' bad']},
  {trustedReviewers:['human-reviewer','Human-Reviewer']},{extra:1}
 ])assert.equal(verifyReceipt({...baseReceipt(),...patch}).reason,'RECEIPT_UNKNOWN');
 assert.equal(verifyReceipt(null).reason,'RECEIPT_UNKNOWN');
 assert.equal(verifyReceipt({repository:'Jamula/SoftwareFactory'}).reason,'RECEIPT_UNKNOWN');

 assert.equal(verifyReceipt({...baseReceipt(),isFork:true}).reason,'FORK_PR_PLATFORM_GATES_UNTRUSTED');
 assert.equal(verifyReceipt({...baseReceipt(),headRepository:'fork-owner/SoftwareFactory'}).reason,'FORK_PR_PLATFORM_GATES_UNTRUSTED');

 for(const patch of [{minimum_coverage:97},{minimum_coverage:101},{minimum_coverage:NaN},{max_coverage_drop:1}])
  assert.equal(verifyReceipt({...baseReceipt(),ruleset:{...baseReceipt().ruleset,...patch}}).reason,'COVERAGE_RULESET_BELOW_TARGET');

 for(const badRuleset of [
  null,{...baseReceipt().ruleset,required_status_checks:null},{...baseReceipt().ruleset,allowed_merge_methods:null},
  {...baseReceipt().ruleset,code_scanning_tools:null},
  {...baseReceipt().ruleset,required_status_checks:[{context:'',integration_id:15368}]},
  {...baseReceipt().ruleset,required_status_checks:[{context:'build-test',integration_id:0}]},
  {...baseReceipt().ruleset,required_status_checks:[...baseReceipt().ruleset.required_status_checks,{context:'build-test',integration_id:15368}]},
  {...baseReceipt().ruleset,code_scanning_tools:[{tool:123,security_alerts_threshold:'medium_or_higher',alerts_threshold:'errors_and_warnings'}]}
 ])assert.equal(verifyReceipt({...baseReceipt(),ruleset:badRuleset}).reason,'RULESET_UNKNOWN');

 for(const patch of [
  {strict_required_status_checks_policy:false},{required_review_thread_resolution:false},
  {required_approving_review_count:-1},{required_approving_review_count:1},{required_approving_review_count:2},
  {allowed_merge_methods:['merge']},{allowed_merge_methods:['squash','merge']},
  {merge_queue_grouping:'SOLO'},{bypass_actors:1},{secret_scanning_required:false},
  {required_status_checks:baseReceipt().ruleset.required_status_checks.slice(0,2)},
  {required_status_checks:baseReceipt().ruleset.required_status_checks.map((c,i)=>i===0?{...c,integration_id:99}:c)},
  {code_scanning_tools:[]},
  {code_scanning_tools:[
   {tool:'CodeQL',security_alerts_threshold:'medium_or_higher',alerts_threshold:'errors_and_warnings'},
   {tool:'DependencyGraph',security_alerts_threshold:'high_or_higher',alerts_threshold:'errors'}
  ]},
  {code_scanning_tools:[{tool:'OtherScanner',security_alerts_threshold:'medium_or_higher',alerts_threshold:'errors_and_warnings'}]},
  {code_scanning_tools:[{tool:'CodeQL',security_alerts_threshold:'high_or_higher',alerts_threshold:'errors_and_warnings'}]},
  {code_scanning_tools:[{tool:'CodeQL',security_alerts_threshold:'medium_or_higher',alerts_threshold:'errors'}]}
 ])assert.equal(verifyReceipt({...baseReceipt(),ruleset:{...baseReceipt().ruleset,...patch}}).reason,'RULESET_INCOMPLETE');

 for(const badPullChecks of [
  null,[{}],[{name:1,head:h,appId:15368,status:'completed',conclusion:'success'}],
  baseReceipt().pullChecks.slice(0,2),
  [...baseReceipt().pullChecks,baseReceipt().pullChecks[0]],
  baseReceipt().pullChecks.map((c,i)=>i===0?{...c,head:mg}:c),
  baseReceipt().pullChecks.map((c,i)=>i===0?{...c,appId:1}:c),
  baseReceipt().pullChecks.map((c,i)=>i===0?{...c,status:'in_progress'}:c),
  baseReceipt().pullChecks.map((c,i)=>i===0?{...c,conclusion:'skipped'}:c)
 ])assert.equal(verifyReceipt({...baseReceipt(),pullChecks:badPullChecks}).reason,'PULL_CHECKS_INCOMPLETE');

 for(const badMgChecks of [
  null,
  baseReceipt().mergeGroupChecks.slice(0,2),
  [...baseReceipt().mergeGroupChecks,baseReceipt().mergeGroupChecks[0]],
  baseReceipt().mergeGroupChecks.map((c,i)=>i===0?{...c,head:h}:c),
  baseReceipt().mergeGroupChecks.map((c,i)=>i===0?{...c,appId:1}:c),
  baseReceipt().mergeGroupChecks.map((c,i)=>i===0?{...c,event:'pull_request'}:c),
  baseReceipt().mergeGroupChecks.map((c,i)=>i===0?{...c,status:'queued'}:c),
  baseReceipt().mergeGroupChecks.map((c,i)=>i===0?{...c,conclusion:'failure'}:c),
  baseReceipt().mergeGroupChecks.map((c,i)=>i===0?{...c,conclusion:'cancelled'}:c)
 ])assert.equal(verifyReceipt({...baseReceipt(),mergeGroupChecks:badMgChecks}).reason,'MERGE_GROUP_CHECKS_INCOMPLETE');

 for(const badCs of [
  null,{tool:'CodeQL',head:h,status:'completed',openAlerts:0},
  {tool:'Other',head:h,status:'completed',conclusion:'success',openAlerts:0},
  {tool:'CodeQL',head:mg,status:'completed',conclusion:'success',openAlerts:0},
  {tool:'CodeQL',head:h,status:'in_progress',conclusion:'success',openAlerts:0},
  {tool:'CodeQL',head:h,status:'completed',conclusion:'failure',openAlerts:0},
  {tool:'CodeQL',head:h,status:'completed',conclusion:'skipped',openAlerts:0},
  {tool:'CodeQL',head:h,status:'completed',conclusion:'cancelled',openAlerts:0},
  {tool:'CodeQL',head:h,status:'completed',conclusion:'success',openAlerts:1},
  {tool:'CodeQL',head:h,status:'completed',conclusion:'success',openAlerts:1.5}
 ])assert.equal(verifyReceipt({...baseReceipt(),codeScanning:badCs}).reason,'CODEQL_ALERTS_OR_INCOMPLETE');

 assert.equal(verifyReceipt({...baseReceipt(),secretScanningClear:false}).reason,'SECURITY_OR_THREADS_UNRESOLVED');
 assert.equal(verifyReceipt({...baseReceipt(),threadsResolved:false}).reason,'SECURITY_OR_THREADS_UNRESOLVED');

 for(const patch of [
  {head:mg},{independent:false},{reviewer:' bad'},{author:''},{agent:''},
  {reviewer:'outside-user',state:'APPROVED'},
  {reviewer:'human-reviewer',state:'COMMENTED'},{state:'CHANGES_REQUESTED'},
  {summaryDisposition:'actionable'},{summaryDisposition:'uncertain'},
  {unresolvedSummaryFindings:1},{blockingReviewCount:1}
 ])assert.equal(verifyReceipt({...baseReceipt(),review:{...baseReceipt().review,...patch}}).reason,'INDEPENDENT_REVIEW_INCOMPLETE');
 assert.equal(verifyReceipt({...baseReceipt(),trustedReviewers:['human-reviewer']}).reason,'INDEPENDENT_REVIEW_INCOMPLETE');
 assert.equal(verifyReceipt({...baseReceipt(),trustedReviewers:['contributor','human-reviewer'],review:{...baseReceipt().review,reviewer:'Contributor',state:'APPROVED'}}).reason,'INDEPENDENT_REVIEW_INCOMPLETE');
 assert.equal(verifyReceipt({...baseReceipt(),trustedReviewers:['coding-agent','human-reviewer'],review:{...baseReceipt().review,reviewer:'Coding-Agent',state:'APPROVED'}}).reason,'INDEPENDENT_REVIEW_INCOMPLETE');
 assert.equal(verifyReceipt({...baseReceipt(),review:null}).reason,'INDEPENDENT_REVIEW_INCOMPLETE');

 const stricterRulesetReceipt=baseReceipt();
 stricterRulesetReceipt.ruleset={...stricterRulesetReceipt.ruleset,minimum_coverage:99};
 assert.equal(verifyReceipt(stricterRulesetReceipt).reason,'COVERAGE_UNVERIFIED');

 const zero={component:'schema',head:h,lines:50,lineTotal:50,branches:0,branchTotal:0};
 const branchlessEntry={component:'schema',head:h,reviewedBy:'independent-reviewer',reason:'pure constant schema definition'};
 assert.equal(verifyReceipt({...baseReceipt(),expectedComponents:['core','schema'],coverageReports:[r,zero]}).reason,'COVERAGE_UNVERIFIED');
 assert.equal(verifyReceipt({...baseReceipt(),expectedComponents:['core','schema'],coverageReports:[r,zero],branchless:[branchlessEntry]}).valid,true);
 assert.equal(verifyReceipt({...baseReceipt(),expectedComponents:['core','schema'],coverageReports:[r,zero],branchless:[{...branchlessEntry,head:mg}]}).reason,'COVERAGE_UNVERIFIED');

 let traps=0;
 const trap=()=>{traps++;throw Error('unexpected proxy trap');};
 const getterBranchless=baseReceipt();
 Object.defineProperty(getterBranchless,'branchless',{get:trap,enumerable:true});
 assert.equal(verifyReceipt(getterBranchless).reason,'RECEIPT_UNKNOWN');
 assert.equal(verifyReceipt(new Proxy(baseReceipt(),{get:trap,ownKeys:trap})).reason,'RECEIPT_UNKNOWN');
 assert.equal(verifyReceipt({...baseReceipt(),ruleset:new Proxy(baseReceipt().ruleset,{get:trap})}).reason,'RULESET_UNKNOWN');
 assert.equal(verifyReceipt({...baseReceipt(),review:new Proxy(baseReceipt().review,{get:trap})}).reason,'INDEPENDENT_REVIEW_INCOMPLETE');
 assert.equal(traps,0);
});
