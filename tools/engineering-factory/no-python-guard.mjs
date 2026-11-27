// Repository and CI guard enforcing the owner directive: zero tracked Python files,
// Python manifests, npm script Python invocations, or workflow Python executions.
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {readBoundedFile} from './verify-dashboard-api.mjs';

const PYTHON_PATH_PATTERN=/\.(?:py|pyw|pyc|pyo|pyd|pyi|ipynb)$/i;
const PYTHON_MANIFEST_PATTERN=/(?:^|\/)(?:\.python-version|requirements(?:[-_.][A-Za-z0-9_.-]+)?\.txt|Pipfile(?:\.lock)?|pyproject\.toml|poetry\.lock|uv\.lock|setup\.cfg|tox\.ini)$/i;
const WORKFLOW_PATH_PATTERN=/^(?:\.github\/workflows\/[^/]+|(?:|\.github\/actions\/.+\/)action)\.(?:yml|yaml)$/i;
const WORKFLOW_PYTHON_ACTION_PATTERN=/\bsetup-python\b/i;
const WORKFLOW_PYTHON_COMMAND_PATTERN=/(?:^|[^\w.-])(?:python(?:\d+(?:\.\d+)?)?(?:\.exe)?|py\.exe|py(?=\s+-)|pip(?:\d+(?:\.\d+)?)?(?:\.exe)?|pipx(?:\.exe)?|uvx(?:\.exe)?|pytest(?:\.exe)?|pipenv|poetry\s+run|uv\s+(?:tool\s+)?run|conda\s+run)(?=$|[^\w.-])/i;
const WORKFLOW_PYTHON_SCRIPT_PATTERN=/(?:^|[^\w.-])[A-Za-z0-9_./\\$-]+\.pyw?(?=$|[^\w.-])/i;

export function hasPythonCommand(line){
  return WORKFLOW_PYTHON_ACTION_PATTERN.test(line)||
    WORKFLOW_PYTHON_COMMAND_PATTERN.test(line)||
    WORKFLOW_PYTHON_SCRIPT_PATTERN.test(line);
}

export function verifyNoPythonInventory({trackedFiles,workflows,packageJson}){
  if(!Array.isArray(trackedFiles)||trackedFiles.length===0)throw Error('MISSING_TRACKED_INVENTORY');
  for(const file of trackedFiles){
    if(typeof file!=='string'||file.length===0)throw Error('INVALID_TRACKED_PATH');
    const normalized=file.replaceAll('\\','/');
    if(PYTHON_PATH_PATTERN.test(normalized)||PYTHON_MANIFEST_PATTERN.test(normalized))
      throw Error('TRACKED_PYTHON_FORBIDDEN');
  }
  if(!Array.isArray(workflows)||workflows.length===0)throw Error('MISSING_WORKFLOW_INVENTORY');
  for(const workflow of workflows){
    if(workflow===null||typeof workflow!=='object'||typeof workflow.path!=='string'||typeof workflow.content!=='string'||
       !WORKFLOW_PATH_PATTERN.test(workflow.path.replaceAll('\\','/')))
      throw Error('INVALID_WORKFLOW_ENTRY');
    for(const rawLine of workflow.content.split(/\r?\n/)){
      const trimmed=rawLine.trim();
      if(trimmed.length===0||trimmed.startsWith('#'))continue;
      if(hasPythonCommand(trimmed))throw Error('WORKFLOW_PYTHON_FORBIDDEN');
    }
  }
  if(packageJson===null||typeof packageJson!=='object'||Array.isArray(packageJson))
    throw Error('INVALID_PACKAGE_JSON');
  const scripts=packageJson.scripts;
  if(scripts===null||typeof scripts!=='object'||Array.isArray(scripts))
    throw Error('INVALID_PACKAGE_SCRIPTS');
  for(const [name,command] of Object.entries(scripts)){
    if(typeof name!=='string'||typeof command!=='string'||hasPythonCommand(command))
      throw Error('PACKAGE_SCRIPT_PYTHON_FORBIDDEN');
  }
  return {valid:true,trackedCount:trackedFiles.length,workflowCount:workflows.length};
}

export function verifyRepositoryNoPython(repoRoot=process.cwd()){
  const trackedFiles=execFileSync('git',['ls-files','-z'],{cwd:repoRoot,encoding:'utf8'}).split('\0').filter(Boolean);
  const workflowPaths=trackedFiles.filter(p=>WORKFLOW_PATH_PATTERN.test(p.replaceAll('\\','/')));
  const workflows=workflowPaths.map(path=>({
    path,
    content:readBoundedFile(join(repoRoot,path),1_000_000).toString('utf8')
  }));
  const packageJson=JSON.parse(readBoundedFile(join(repoRoot,'package.json'),1_000_000).toString('utf8'));
  return verifyNoPythonInventory({trackedFiles,workflows,packageJson});
}
