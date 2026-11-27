import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  CODEQL_PYTHON_REMEDIATION,
  evaluateCodeqlPythonResidual,
  hasPythonCommand,
  verifyNoPythonInventory,
  verifyRepositoryNoPython
} from '../../tools/engineering-factory/no-python-guard.mjs';

const validFixture=()=>({
  trackedFiles:[
    'package.json',
    'tools/engineering-factory/verify-dashboard-api.mjs',
    'tests/engineering-factory/verify-dashboard-api.test.mjs',
    '.github/workflows/validate.yml'
  ],
  workflows:[{
    path:'.github/workflows/validate.yml',
    content:[
      '# Historical comment: replaced python scripts with Node 26',
      'name: Factory validation',
      'jobs:',
      '  test:',
      '    steps:',
      '      - run: npm run test:coverage',
      '      - run: node tools/engineering-factory/verify-dashboard-export.mjs "$archive"'
    ].join('\n')
  }],
  packageJson:{
    scripts:{
      test:'node --test tests/engineering-factory/*.test.mjs',
      'test:coverage':'node --test --experimental-test-coverage'
    }
  }
});

test('repository enforces zero tracked Python files, manifests, or workflow/script Python invocations',()=>{
  const summary=verifyRepositoryNoPython();
  assert.equal(summary.valid,true);
  assert.equal(Object.isFrozen(summary),true);
  assert.ok(summary.trackedCount>0);
  assert.ok(summary.workflowCount>=2);
  assert.deepEqual(verifyRepositoryNoPython(process.cwd()),summary);
  for(const badRoot of [null,123,'','bad\0root']){
    assert.throws(()=>verifyRepositoryNoPython(badRoot),/INVALID_REPO_ROOT/);
  }
});

test('verifyNoPythonInventory accepts Node-only inventory and rejects tracked Python files, manifests, or non-plain inputs',()=>{
  assert.deepEqual(verifyNoPythonInventory(validFixture()),{valid:true,trackedCount:4,workflowCount:1});
  assert.equal(hasPythonCommand('cp foo copy_happy.mjs'),false);
  for(const nonString of [null,undefined,42,{toString(){throw Error('UNEXPECTED_COERCION');}}]){
    assert.throws(()=>hasPythonCommand(nonString),/INVALID_COMMAND_LINE/);
  }

  const revokedInventory=Proxy.revocable(validFixture(),{});
  revokedInventory.revoke();
  const getterInventory=validFixture();
  Object.defineProperty(getterInventory,'trackedFiles',{
    enumerable:true,
    get(){throw Error('GETTER_INVOKED');}
  });
  for(const badInventory of [
    null,
    [],
    Object.create(validFixture()),
    new Proxy(validFixture(),{}),
    revokedInventory.proxy,
    getterInventory,
    {...validFixture(),extra:true},
    {...validFixture(),trackedFiles:undefined},
    {trackedFiles:validFixture().trackedFiles,workflows:validFixture().workflows},
    Object.assign(validFixture(),{[Symbol('tag')]:1})
  ]){
    assert.throws(()=>verifyNoPythonInventory(badInventory),/INVALID_INVENTORY/);
  }

  const sparseTracked=['package.json',,'.github/workflows/validate.yml'];
  const getterTracked=['package.json','.github/workflows/validate.yml'];
  Object.defineProperty(getterTracked,'0',{enumerable:true,get(){throw Error('ARRAY_GETTER');}});
  for(const badTracked of [null,[],sparseTracked,getterTracked,new Proxy(['package.json'],{})]){
    assert.throws(()=>verifyNoPythonInventory({...validFixture(),trackedFiles:badTracked}),/MISSING_TRACKED_INVENTORY/);
  }
  for(const badPath of ['',[123][0],'bad\0file.mjs']){
    assert.throws(
      ()=>verifyNoPythonInventory({...validFixture(),trackedFiles:[...validFixture().trackedFiles,badPath]}),
      /INVALID_TRACKED_PATH/
    );
  }
  assert.throws(
    ()=>verifyNoPythonInventory({...validFixture(),trackedFiles:[...validFixture().trackedFiles,'tools\\engineering-factory\\verify-dashboard-api.mjs']}),
    /INVALID_TRACKED_PATH/
  );

  for(const forbiddenFile of [
    'tests/engineering-factory/verify-dashboard-api.py',
    'tools/helper.pyw',
    'nested\\win\\script.PY',
    'cache/mod.pyc',
    'types/stub.pyi',
    'dist/tool.pyz',
    'dist/pkg-0.1.0-py3-none-any.whl',
    'notebook.ipynb',
    '.python-version',
    'requirements.txt',
    'sub/requirements-dev.txt',
    'pyproject.toml',
    'Pipfile',
    'Pipfile.lock',
    'poetry.lock',
    'uv.lock',
    'setup.cfg',
    'tox.ini'
  ]){
    const f=validFixture();
    f.trackedFiles.push(forbiddenFile);
    assert.throws(()=>verifyNoPythonInventory(f),/TRACKED_PYTHON_FORBIDDEN/,forbiddenFile);
  }
});

test('verifyNoPythonInventory rejects Python workflow actions, interpreters, package managers, scripts, and hostile descriptors',()=>{
  for(const badWorkflows of [
    null,
    [],
    [null],
    [new Proxy(validFixture().workflows[0],{})],
    [{path:'not-a-workflow.yml',content:'name: x'}],
    [{path:'.github/workflows/untracked.yml',content:'name: x'}],
    [{path:'',content:'name: x'}],
    [{path:'.github/workflows/bad\0.yml',content:'name: x'}],
    [{path:'.github/workflows/a.yml',content:123}],
    [validFixture().workflows[0],{path:'.github\\workflows\\validate.yml',content:'name: dup'}]
  ]){
    assert.throws(()=>verifyNoPythonInventory({...validFixture(),workflows:badWorkflows}));
  }

  for(const line of [
    '      - uses: actions/setup-python@v5',
    '      - uses: astral-sh/setup-uv@v5',
    "        languages: javascript-typescript, python",
    "        language: ['javascript-typescript', 'python']",
    '        run: python tests/engineering-factory/verify-dashboard-api.py',
    '        run: python3 -m unittest',
    '        run: /usr/bin/python3 -m unittest',
    '        run: C:/hostedtoolcache/windows/Python/3.12.0/x64/python.exe -c 1',
    '        run: python2.7 -c 1',
    '        run: python3.12 script',
    '        run: py',
    '        run: py < commands.txt',
    '        run: py -3 -m unittest',
    '        run: py.exe tool',
    '        run: /usr/local/bin/pip3 install foo',
    '        run: pip install -r deps',
    '        run: pipx run black',
    '        run: uvx ruff check',
    '        run: pytest -q',
    '        run: uv run tool',
    '        run: uv tool run ruff',
    '        run: conda run -n env tool',
    '        run: poetry run check',
    '        run: ./scripts/check.py',
    '        run: tools/helper.pyw'
  ]){
    const f=validFixture();
    f.workflows[0].content+=`\n${line}\n`;
    assert.throws(()=>verifyNoPythonInventory(f),/WORKFLOW_PYTHON_FORBIDDEN/,line);
  }

  for(const actionPath of ['action.yml','.github/actions/custom/action.yml','tools/local-action/action.yml','packages/nested/sub/action.yaml']){
    const omitted=validFixture();
    omitted.trackedFiles.push(actionPath);
    assert.throws(()=>verifyNoPythonInventory(omitted),/MISSING_WORKFLOW_INVENTORY/,actionPath);

    const actionFixture=validFixture();
    actionFixture.trackedFiles.push(actionPath);
    actionFixture.workflows.push({path:actionPath,content:'runs:\n  using: composite\n  steps:\n    - run: python3 -c 1'});
    assert.throws(()=>verifyNoPythonInventory(actionFixture),/WORKFLOW_PYTHON_FORBIDDEN/,actionPath);
  }

  const protoPkg=JSON.parse('{"__proto__":{"polluted":true},"scripts":{"test":"node --test"}}');
  const getterScripts={};
  Object.defineProperty(getterScripts,'test',{enumerable:true,get(){throw Error('SCRIPT_GETTER');}});
  const nonEnumPkg={scripts:{test:'node --test'}};
  Object.defineProperty(nonEnumPkg,'hidden',{enumerable:false,value:1});

  for(const badPkg of [
    null,
    [],
    new Proxy({scripts:{test:'node --test'}},{}),
    Object.create(null),
    protoPkg,
    nonEnumPkg,
    {},
    {scripts:null},
    {scripts:[]},
    {scripts:getterScripts},
    {scripts:{'':'node --test'}},
    {scripts:{bad:123}},
    {scripts:{check:'python3 test.py'}},
    {scripts:{repl:'py'}},
    {scripts:{stdin:'py < commands.txt'}}
  ]){
    assert.throws(()=>verifyNoPythonInventory({...validFixture(),packageJson:badPkg}));
  }
});

test('evaluateCodeqlPythonResidual detects stale Analyze (python) on verified cec2745 evidence and clears once removed',()=>{
  const evidencePath=join(process.cwd(),'docs/evidence/m01-02-01-no-python-acceptance.json');
  const evidence=JSON.parse(readFileSync(evidencePath,'utf8'));
  assert.equal(evidence.verifiedMainCandidate.headSha,'cec2745b7b8a21e77ad9f2839d4255d42305d419');
  assert.equal(evidence.hostedRuntimeRuns.linuxFactoryValidation.runId,45975774012);
  assert.equal(evidence.hostedRuntimeRuns.windowsAspireRuntime.runId,45975774125);
  assert.equal(evidence.codeqlDefaultSetupBlocker.runId,45975773999);

  const residual=evaluateCodeqlPythonResidual(evidence.checkRuns);
  assert.equal(Object.isFrozen(residual),true);
  assert.equal(Object.isFrozen(residual.matchedChecks),true);
  assert.deepEqual(residual,{
    valid:false,
    residualPythonCodeql:true,
    remediation:'Uncheck python in Settings -> Code security -> Code scanning -> Default setup',
    reason:'CODEQL_PYTHON_RESIDUAL',
    matchedChecks:['Analyze (python)']
  });
  assert.equal(residual.remediation,CODEQL_PYTHON_REMEDIATION);

  // Duplicate stale Python check runs (e.g., queued/in-progress or prefixed workflow context) deduplicate deterministically.
  const duplicatePythonResult=evaluateCodeqlPythonResidual({
    total_count:3,
    incomplete_results:false,
    check_runs:[
      {id:1,name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',app:{id:15368,slug:'github-actions',name:'GitHub Actions'}},
      {id:2,name:'Analyze (python)',status:'in_progress',conclusion:null,completed_at:null,started_at:null,details_url:null,html_url:null},
      {id:3,name:'Analyze (python)',status:'queued'}
    ]
  });
  assert.deepEqual(duplicatePythonResult,{
    valid:false,
    residualPythonCodeql:true,
    remediation:CODEQL_PYTHON_REMEDIATION,
    reason:'CODEQL_PYTHON_RESIDUAL',
    matchedChecks:['Analyze (python)']
  });

  const prefixedPythonResult=evaluateCodeqlPythonResidual([
    {name:'Push on main / Analyze (Python)',status:'completed',conclusion:'failure'},
    {name:'CodeQL (python)',status:'completed',conclusion:'neutral'}
  ]);
  assert.equal(prefixedPythonResult.valid,false);
  assert.equal(prefixedPythonResult.residualPythonCodeql,true);
  assert.equal(prefixedPythonResult.remediation,CODEQL_PYTHON_REMEDIATION);
  assert.deepEqual(prefixedPythonResult.matchedChecks,['Push on main / Analyze (Python)','CodeQL (python)']);

  // Once python is unchecked in Default Setup, remaining check runs pass cleanly.
  const cleanedCheckRuns=evidence.checkRuns.filter(run=>run.name!=='Analyze (python)');
  const cleanResult=evaluateCodeqlPythonResidual({
    total_count:cleanedCheckRuns.length,
    incomplete_results:false,
    check_runs:cleanedCheckRuns
  });
  assert.deepEqual(cleanResult,{
    valid:true,
    residualPythonCodeql:false,
    remediation:null,
    reason:'CODEQL_PYTHON_ABSENT',
    matchedChecks:[]
  });

  // Also supports fractional-second ISO timestamps and matching head/head_sha fields.
  const headMatched=evaluateCodeqlPythonResidual([
    {
      id:10,
      name:'CodeQL',
      head:'cec2745b7b8a21e77ad9f2839d4255d42305d419',
      head_sha:'cec2745b7b8a21e77ad9f2839d4255d42305d419',
      app:'github-code-scanning',
      status:'completed',
      conclusion:'success',
      started_at:'2026-11-27T09:41:19.1234567Z',
      completed_at:'2026-11-27T09:42:00.5Z',
      details_url:'https://github.com/Jamula/SoftwareFactory/runs/10'
    },
    {
      id:11,
      name:'CodeQL (javascript-typescript)',
      head:'cec2745b7b8a21e77ad9f2839d4255d42305d419',
      app:{slug:'github-actions'},
      status:'completed',
      conclusion:'success'
    }
  ]);
  assert.equal(headMatched.valid,true);
  assert.equal(headMatched.residualPythonCodeql,false);
});

test('evaluateCodeqlPythonResidual fails closed on missing, incomplete, untrusted, proxy, or malformed check runs',()=>{
  assert.deepEqual(evaluateCodeqlPythonResidual([]),{
    valid:false,
    residualPythonCodeql:false,
    remediation:null,
    reason:'MISSING_CODEQL_CHECKS',
    matchedChecks:[]
  });

  assert.deepEqual(evaluateCodeqlPythonResidual([
    {id:1,name:'build-test',status:'completed',conclusion:'success',app:'github-actions'},
    {id:2,name:'pinned-synthetic-replay / replay',status:'completed',conclusion:'success',app:'github-actions'}
  ]),{
    valid:false,
    residualPythonCodeql:false,
    remediation:null,
    reason:'MISSING_CODEQL_CHECKS',
    matchedChecks:[]
  });

  for(const untrustedEntry of [
    {id:1,name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',app:'untrusted-bot'},
    {id:2,name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success'},
    {id:3,name:'CodeQL',status:'completed',conclusion:'success'}
  ]){
    assert.deepEqual(evaluateCodeqlPythonResidual([untrustedEntry]),{
      valid:false,
      residualPythonCodeql:false,
      remediation:null,
      reason:'UNTRUSTED_CODEQL_PRODUCER',
      matchedChecks:[]
    });
  }

  for(const incompleteEntry of [
    {id:1,name:'Analyze (javascript-typescript)',status:'in_progress',conclusion:null,app:'github-actions'},
    {id:2,name:'Analyze (javascript-typescript)',status:'completed',conclusion:'failure',app:'github-actions'}
  ]){
    assert.deepEqual(evaluateCodeqlPythonResidual([incompleteEntry]),{
      valid:false,
      residualPythonCodeql:false,
      remediation:null,
      reason:'CODEQL_CHECKS_INCOMPLETE',
      matchedChecks:[]
    });
  }

  const revoked=Proxy.revocable([],{});
  revoked.revoke();
  const getterRun={status:'completed',conclusion:'success'};
  Object.defineProperty(getterRun,'name',{enumerable:true,get(){throw Error('CHECK_GETTER');}});
  const oversizedChecks=Array.from({length:257},(_,i)=>({
    id:i+1,
    name:'Analyze (javascript-typescript)',
    status:'completed',
    conclusion:'success'
  }));

  for(const invalidInput of [
    null,
    undefined,
    'checks',
    new Proxy([],{}),
    revoked.proxy,
    oversizedChecks,
    {check_runs:'not-array'},
    {check_runs:[],total_count:2},
    {check_runs:[],total_count:-1},
    {check_runs:[],incomplete_results:true},
    {check_runs:[],extra:1},
    [null],
    [new Proxy({name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success'},{})],
    [getterRun],
    [{name:'   ',status:'completed',conclusion:'success'}],
    [{name:'Analyze (javascript-typescript)',status:'unknown',conclusion:'success'}],
    [{name:'Analyze (javascript-typescript)',status:'completed'}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'invalid'}],
    [{name:'Analyze (javascript-typescript)',status:'in_progress',conclusion:'success'}],
    [{name:'Analyze (javascript-typescript)',status:'in_progress',completed_at:'2026-11-27T09:42:00Z'}],
    [{id:0,name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success'}],
    [
      {id:5,name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success'},
      {id:5,name:'Analyze (csharp)',status:'completed',conclusion:'success'}
    ],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',head_sha:'bad-sha'}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',head:'bad-sha'}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',head_sha:{toString(){throw Error('SHA_TOSTRING');}}}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',head_sha:{toString:null}}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',head:{[Symbol.toPrimitive](){throw Error('SHA_TOPRIMITIVE');}}}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',head:revoked.proxy}],
    [{
      name:'Analyze (javascript-typescript)',
      status:'completed',
      conclusion:'success',
      head_sha:'cec2745b7b8a21e77ad9f2839d4255d42305d419',
      head:'824031eb8d9d79c5dec03043a96ee575293978c0'
    }],
    [
      {name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',head_sha:'cec2745b7b8a21e77ad9f2839d4255d42305d419'},
      {name:'Analyze (csharp)',status:'completed',conclusion:'success',head:'824031eb8d9d79c5dec03043a96ee575293978c0'}
    ],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',app:'INVALID_UPPERCASE'}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',app:123}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',app:{slug:'BAD SLUG'}}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',app:{slug:'github-actions',id:0}}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',app:{slug:'github-actions',name:'  '}}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',details_url:123}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',details_url:''}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',details_url:`https://example.com/${'a'.repeat(510)}`}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',details_url:'https://example.com/\u0007'}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',details_url:'https://example.com/a b'}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',details_url:'https://\\example.com'}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',details_url:'https:///example.com'}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',details_url:'http://insecure.example.com'}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',html_url:'https://#'}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',html_url:'https://user@example.com/run'}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',html_url:'https://:secret@example.com/run'}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',html_url:'not-a-url'}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',started_at:123}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',started_at:'2026-11-27'}],
    [{name:'Analyze (javascript-typescript)',status:'completed',conclusion:'success',completed_at:'2026-02-30T09:41:54Z'}]
  ]){
    const res=evaluateCodeqlPythonResidual(invalidInput);
    assert.equal(res.valid,false);
    assert.equal(res.residualPythonCodeql,false);
    assert.equal(res.remediation,null);
    assert.equal(res.reason,'INVALID_CHECK_RUNS');
  }
});
