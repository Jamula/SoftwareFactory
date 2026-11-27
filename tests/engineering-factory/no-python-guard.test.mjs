import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
  assert.ok(summary.trackedCount>0);
  assert.ok(summary.workflowCount>=2);
});

test('verifyNoPythonInventory accepts Node-only inventory and rejects tracked Python files or manifests',()=>{
  assert.deepEqual(verifyNoPythonInventory(validFixture()),{valid:true,trackedCount:4,workflowCount:1});
  assert.equal(hasPythonCommand('cp foo copy_happy.mjs'),false);

  for(const badTracked of [null,[],[''],[123]]){
    assert.throws(()=>verifyNoPythonInventory({...validFixture(),trackedFiles:badTracked}));
  }
  for(const forbiddenFile of [
    'tests/engineering-factory/verify-dashboard-api.py',
    'tools/helper.pyw',
    'nested\\win\\script.PY',
    'cache/mod.pyc',
    'types/stub.pyi',
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

test('verifyNoPythonInventory rejects Python workflow actions, interpreters, package managers, and scripts',()=>{
  for(const badWorkflows of [
    null,[],[null],[{path:'not-a-workflow.yml',content:'name: x'}],[{path:'.github/workflows/a.yml',content:123}]
  ]){
    assert.throws(()=>verifyNoPythonInventory({...validFixture(),workflows:badWorkflows}));
  }

  for(const line of [
    '      - uses: actions/setup-python@v5',
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

  for(const badPkg of [
    null,[],{scripts:null},{scripts:[]},{scripts:{bad:123}},
    {scripts:{check:'python3 test.py'}},{scripts:{repl:'py'}},{scripts:{stdin:'py < commands.txt'}}
  ]){
    assert.throws(()=>verifyNoPythonInventory({...validFixture(),packageJson:badPkg}));
  }
});
