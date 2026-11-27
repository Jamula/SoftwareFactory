// Repository and CI guard enforcing the owner directive: zero tracked Python files,
// Python manifests, npm script Python invocations, workflow Python executions,
// or residual CodeQL Python language checks after Python removal.
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {types} from 'node:util';
import {readBoundedFile} from './verify-dashboard-api.mjs';

export const CODEQL_PYTHON_REMEDIATION=
  'Uncheck python in Settings -> Code security -> Code scanning -> Default setup';

const MAX_INVENTORY_ITEMS=100_000;
const MAX_CHECK_RUNS=256;
const MAX_PACKAGE_KEYS=512;
const FORBIDDEN_OBJECT_KEYS=new Set(['__proto__','constructor','prototype']);
const CONTROL_CHAR_PATTERN=/[\u0000-\u001f\u007f]/;
const SHA40_PATTERN=/^[a-f0-9]{40}$/;
const APP_SLUG_PATTERN=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HTTPS_URL_PATTERN=/^https:\/\/\S+$/;
const ISO_UTC_PATTERN=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?Z$/;

const PYTHON_PATH_PATTERN=/\.(?:py|pyw|pyc|pyo|pyd|pyi|pyz|whl|ipynb)$/i;
const PYTHON_MANIFEST_PATTERN=/(?:^|\/)(?:\.python-version|requirements(?:[-_.][A-Za-z0-9_.-]+)?\.txt|Pipfile(?:\.lock)?|pyproject\.toml|poetry\.lock|uv\.lock|setup\.cfg|tox\.ini)$/i;
const WORKFLOW_PATH_PATTERN=/^(?:\.github\/workflows\/[^/]+|(?:[^/]+\/)*action)\.(?:yml|yaml)$/i;
const WORKFLOW_PYTHON_ACTION_PATTERN=/\b(?:setup-python|setup-uv|setup-poetry|setup-miniconda)\b/i;
const WORKFLOW_PYTHON_COMMAND_PATTERN=/(?:^|[^\w.-])(?:python(?:\d+(?:\.\d+)?)?(?:\.exe)?|py(?:\.exe)?|pip(?:\d+(?:\.\d+)?)?(?:\.exe)?|pipx(?:\.exe)?|uvx(?:\.exe)?|pytest(?:\.exe)?|pipenv|poetry\s+run|uv\s+(?:tool\s+)?run|conda\s+run)(?=$|[^\w.-])/i;
const WORKFLOW_PYTHON_SCRIPT_PATTERN=/(?:^|[^\w.-])[A-Za-z0-9_./\\$-]+\.pyw?(?=$|[^\w.-])/i;

const CHECK_RUN_STATUSES=new Set(['queued','in_progress','completed','waiting','requested','pending']);
const CHECK_RUN_CONCLUSIONS=new Set([
  'success','failure','neutral','cancelled','skipped','timed_out','action_required','stale','startup_failure'
]);
const TRUSTED_CODEQL_APPS=new Set(['github-actions','github-code-scanning']);
const CODEQL_ANALYZE_LEAF_PATTERN=/^Analyze\x20*\(\x20*([a-z0-9_+-]+)\x20*\)$/i;
const CODEQL_NAMED_LEAF_PATTERN=/^CodeQL(?:\x20*\(\x20*([a-z0-9_+-]+)\x20*\))?$/i;
const PYTHON_LANGUAGE_PATTERN=/^python\d*$/i;

const INVENTORY_KEYS=new Set(['trackedFiles','workflows','packageJson']);
const WORKFLOW_ENTRY_KEYS=new Set(['path','content']);
const CHECK_ENVELOPE_KEYS=new Set(['check_runs','total_count','incomplete_results']);
const CHECK_RUN_KEYS=new Set([
  'id','name','status','conclusion','app','head_sha','head','details_url','html_url','started_at','completed_at'
]);
const CHECK_APP_KEYS=new Set(['id','slug','name']);

function isOwnEnumerableData(target,key){
  const descriptor=Object.getOwnPropertyDescriptor(target,key);
  return descriptor!==undefined&&descriptor.enumerable===true&&Object.hasOwn(descriptor,'value');
}

function isPlainObject(value){
  return value!==null&&typeof value==='object'&&!types.isProxy(value)&&
    !Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
}

function isPlainMap(value,maxKeys=MAX_PACKAGE_KEYS){
  if(!isPlainObject(value))return false;
  const keys=Reflect.ownKeys(value);
  return keys.length<=maxKeys&&keys.every(
    key=>typeof key==='string'&&!FORBIDDEN_OBJECT_KEYS.has(key)&&isOwnEnumerableData(value,key)
  );
}

function isPlainRecord(value,allowedKeys,requiredKeys){
  if(!isPlainMap(value,allowedKeys.size))return false;
  for(const key of Object.keys(value)){
    if(!allowedKeys.has(key)||value[key]===undefined)return false;
  }
  return requiredKeys.every(key=>Object.hasOwn(value,key));
}

function isDenseArray(value,maxLen=MAX_INVENTORY_ITEMS){
  if(value===null||typeof value!=='object'||types.isProxy(value)||!Array.isArray(value)||
     Object.getPrototypeOf(value)!==Array.prototype||value.length>maxLen||
     Reflect.ownKeys(value).length!==value.length+1){
    return false;
  }
  for(let i=0;i<value.length;i++){
    if(!isOwnEnumerableData(value,String(i)))return false;
  }
  return true;
}

const isBoundedText=(value,maxLen)=>
  typeof value==='string'&&value.trim().length>0&&value.length<=maxLen&&!CONTROL_CHAR_PATTERN.test(value);

const isOptionalHttpsUrl=value=>
  value===null||(typeof value==='string'&&value.length<=512&&!CONTROL_CHAR_PATTERN.test(value)&&HTTPS_URL_PATTERN.test(value));

function classifyCodeqlCheckName(name){
  const slashIndex=name.lastIndexOf('/');
  const leaf=(slashIndex===-1?name:name.slice(slashIndex+1)).trim();
  const analyzeMatch=CODEQL_ANALYZE_LEAF_PATTERN.exec(leaf);
  if(analyzeMatch!==null){
    return PYTHON_LANGUAGE_PATTERN.test(analyzeMatch[1])?'python':'codeql';
  }
  const codeqlMatch=CODEQL_NAMED_LEAF_PATTERN.exec(leaf);
  if(codeqlMatch!==null){
    return codeqlMatch[1]!==undefined&&PYTHON_LANGUAGE_PATTERN.test(codeqlMatch[1])
      ?'python'
      :'codeql';
  }
  return 'none';
}

function isOptionalIsoTimestamp(value){
  if(value===null)return true;
  if(typeof value!=='string')return false;
  const match=ISO_UTC_PATTERN.exec(value);
  if(match===null)return false;
  const parsed=new Date(value);
  return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,19)===match[1];
}

function resolveAppSlug(app){
  if(typeof app==='string')return APP_SLUG_PATTERN.test(app)&&app.length<=100?app:null;
  if(!isPlainRecord(app,CHECK_APP_KEYS,['slug']))return null;
  if(typeof app.slug!=='string'||app.slug.length>100||!APP_SLUG_PATTERN.test(app.slug))return null;
  if(Object.hasOwn(app,'id')&&(!Number.isSafeInteger(app.id)||app.id<=0))return null;
  if(Object.hasOwn(app,'name')&&!isBoundedText(app.name,120))return null;
  return app.slug;
}

function validateCheckRunEntry(entry,seenIds,headState){
  if(!isPlainRecord(entry,CHECK_RUN_KEYS,['name','status']))return null;
  if(!isBoundedText(entry.name,200)||!CHECK_RUN_STATUSES.has(entry.status))return null;
  if(entry.status==='completed'){
    if(!Object.hasOwn(entry,'conclusion')||!CHECK_RUN_CONCLUSIONS.has(entry.conclusion))return null;
  }else if((Object.hasOwn(entry,'conclusion')&&entry.conclusion!==null)||
           (Object.hasOwn(entry,'completed_at')&&entry.completed_at!==null)){
    return null;
  }
  if(Object.hasOwn(entry,'id')){
    if(!Number.isSafeInteger(entry.id)||entry.id<=0||seenIds.has(entry.id))return null;
    seenIds.add(entry.id);
  }
  const hasHeadSha=Object.hasOwn(entry,'head_sha');
  const hasHead=Object.hasOwn(entry,'head');
  if(hasHeadSha&&!SHA40_PATTERN.test(entry.head_sha))return null;
  if(hasHead&&!SHA40_PATTERN.test(entry.head))return null;
  if(hasHeadSha&&hasHead&&entry.head_sha!==entry.head)return null;
  const entryHead=hasHeadSha?entry.head_sha:(hasHead?entry.head:null);
  if(entryHead!==null){
    if(headState.expected!==null&&headState.expected!==entryHead)return null;
    headState.expected=entryHead;
  }
  let appSlug=null;
  if(Object.hasOwn(entry,'app')){
    appSlug=resolveAppSlug(entry.app);
    if(appSlug===null)return null;
  }
  if((Object.hasOwn(entry,'details_url')&&!isOptionalHttpsUrl(entry.details_url))||
     (Object.hasOwn(entry,'html_url')&&!isOptionalHttpsUrl(entry.html_url))||
     (Object.hasOwn(entry,'started_at')&&!isOptionalIsoTimestamp(entry.started_at))||
     (Object.hasOwn(entry,'completed_at')&&!isOptionalIsoTimestamp(entry.completed_at))){
    return null;
  }
  return {
    name:entry.name.trim(),
    status:entry.status,
    conclusion:entry.status==='completed'?entry.conclusion:null,
    appSlug
  };
}

function extractRawCheckRuns(checkRuns){
  if(isDenseArray(checkRuns,MAX_CHECK_RUNS))return checkRuns;
  if(!isPlainRecord(checkRuns,CHECK_ENVELOPE_KEYS,['check_runs']))return null;
  if(!isDenseArray(checkRuns.check_runs,MAX_CHECK_RUNS))return null;
  if(Object.hasOwn(checkRuns,'total_count')&&
     (!Number.isSafeInteger(checkRuns.total_count)||checkRuns.total_count!==checkRuns.check_runs.length)){
    return null;
  }
  if(Object.hasOwn(checkRuns,'incomplete_results')&&checkRuns.incomplete_results!==false)return null;
  return checkRuns.check_runs;
}

const freezeResidualResult=({valid,residualPythonCodeql,remediation,reason,matchedChecks=[]})=>Object.freeze({
  valid,
  residualPythonCodeql,
  remediation,
  reason,
  matchedChecks:Object.freeze(matchedChecks)
});

export function hasPythonCommand(line){
  if(typeof line!=='string')throw Error('INVALID_COMMAND_LINE');
  return WORKFLOW_PYTHON_ACTION_PATTERN.test(line)||
    WORKFLOW_PYTHON_COMMAND_PATTERN.test(line)||
    WORKFLOW_PYTHON_SCRIPT_PATTERN.test(line);
}

export function verifyNoPythonInventory(inventory){
  if(!isPlainRecord(inventory,INVENTORY_KEYS,['trackedFiles','workflows','packageJson']))
    throw Error('INVALID_INVENTORY');
  const {trackedFiles,workflows,packageJson}=inventory;
  if(!isDenseArray(trackedFiles)||trackedFiles.length===0)throw Error('MISSING_TRACKED_INVENTORY');
  const seenTrackedPaths=new Set();
  const expectedWorkflowPaths=new Set();
  for(const file of trackedFiles){
    if(typeof file!=='string'||file.length===0||CONTROL_CHAR_PATTERN.test(file))
      throw Error('INVALID_TRACKED_PATH');
    const normalized=file.replaceAll('\\','/');
    if(seenTrackedPaths.has(normalized))throw Error('INVALID_TRACKED_PATH');
    seenTrackedPaths.add(normalized);
    if(PYTHON_PATH_PATTERN.test(normalized)||PYTHON_MANIFEST_PATTERN.test(normalized))
      throw Error('TRACKED_PYTHON_FORBIDDEN');
    if(WORKFLOW_PATH_PATTERN.test(normalized))expectedWorkflowPaths.add(normalized);
  }
  if(!isDenseArray(workflows)||workflows.length===0)throw Error('MISSING_WORKFLOW_INVENTORY');
  const inspectedWorkflowPaths=new Set();
  for(const workflow of workflows){
    if(!isPlainRecord(workflow,WORKFLOW_ENTRY_KEYS,['path','content'])||
       typeof workflow.path!=='string'||typeof workflow.content!=='string'||
       workflow.path.length===0||CONTROL_CHAR_PATTERN.test(workflow.path)){
      throw Error('INVALID_WORKFLOW_ENTRY');
    }
    const normalizedPath=workflow.path.replaceAll('\\','/');
    if(!WORKFLOW_PATH_PATTERN.test(normalizedPath)||!expectedWorkflowPaths.has(normalizedPath)||inspectedWorkflowPaths.has(normalizedPath))
      throw Error('INVALID_WORKFLOW_ENTRY');
    inspectedWorkflowPaths.add(normalizedPath);
    for(const rawLine of workflow.content.split(/\r?\n/)){
      const trimmed=rawLine.trim();
      if(trimmed.length===0||trimmed.startsWith('#'))continue;
      if(hasPythonCommand(trimmed))throw Error('WORKFLOW_PYTHON_FORBIDDEN');
    }
  }
  for(const requiredPath of expectedWorkflowPaths){
    if(!inspectedWorkflowPaths.has(requiredPath))throw Error('MISSING_WORKFLOW_INVENTORY');
  }
  if(!isPlainMap(packageJson))throw Error('INVALID_PACKAGE_JSON');
  if(!Object.hasOwn(packageJson,'scripts')||!isPlainMap(packageJson.scripts))
    throw Error('INVALID_PACKAGE_SCRIPTS');
  const {scripts}=packageJson;
  for(const name of Object.keys(scripts)){
    const command=scripts[name];
    if(name.length===0||typeof command!=='string'||hasPythonCommand(command))
      throw Error('PACKAGE_SCRIPT_PYTHON_FORBIDDEN');
  }
  return Object.freeze({valid:true,trackedCount:trackedFiles.length,workflowCount:workflows.length});
}

export function verifyRepositoryNoPython(repoRoot=process.cwd()){
  if(typeof repoRoot!=='string'||repoRoot.length===0||CONTROL_CHAR_PATTERN.test(repoRoot))
    throw Error('INVALID_REPO_ROOT');
  const trackedFiles=execFileSync('git',['ls-files','-z'],{cwd:repoRoot,encoding:'utf8'}).split('\0').filter(Boolean);
  const workflowPaths=trackedFiles.filter(p=>WORKFLOW_PATH_PATTERN.test(p.replaceAll('\\','/')));
  const workflows=workflowPaths.map(path=>({
    path,
    content:readBoundedFile(join(repoRoot,path),1_000_000).toString('utf8')
  }));
  const packageJson=JSON.parse(readBoundedFile(join(repoRoot,'package.json'),1_000_000).toString('utf8'));
  return verifyNoPythonInventory({trackedFiles,workflows,packageJson});
}

export function evaluateCodeqlPythonResidual(checkRuns){
  const rawEntries=extractRawCheckRuns(checkRuns);
  if(rawEntries===null){
    return freezeResidualResult({
      valid:false,
      residualPythonCodeql:false,
      remediation:null,
      reason:'INVALID_CHECK_RUNS'
    });
  }
  if(rawEntries.length===0){
    return freezeResidualResult({
      valid:false,
      residualPythonCodeql:false,
      remediation:null,
      reason:'MISSING_CODEQL_CHECKS'
    });
  }
  const seenIds=new Set();
  const headState={expected:null};
  const pythonChecks=[];
  const seenPythonNames=new Set();
  const codeqlChecks=[];
  let hasUntrustedCodeqlProducer=false;

  for(const rawEntry of rawEntries){
    const entry=validateCheckRunEntry(rawEntry,seenIds,headState);
    if(entry===null){
      return freezeResidualResult({
        valid:false,
        residualPythonCodeql:false,
        remediation:null,
        reason:'INVALID_CHECK_RUNS'
      });
    }
    const kind=classifyCodeqlCheckName(entry.name);
    if(kind==='python'){
      if(!seenPythonNames.has(entry.name)){
        seenPythonNames.add(entry.name);
        pythonChecks.push(entry.name);
      }
    }else if(kind==='codeql'){
      if(entry.appSlug!==null&&!TRUSTED_CODEQL_APPS.has(entry.appSlug)){
        hasUntrustedCodeqlProducer=true;
      }else{
        codeqlChecks.push(entry);
      }
    }
  }

  if(pythonChecks.length>0){
    return freezeResidualResult({
      valid:false,
      residualPythonCodeql:true,
      remediation:CODEQL_PYTHON_REMEDIATION,
      reason:'CODEQL_PYTHON_RESIDUAL',
      matchedChecks:pythonChecks
    });
  }
  if(hasUntrustedCodeqlProducer){
    return freezeResidualResult({
      valid:false,
      residualPythonCodeql:false,
      remediation:null,
      reason:'UNTRUSTED_CODEQL_PRODUCER'
    });
  }
  if(codeqlChecks.length===0){
    return freezeResidualResult({
      valid:false,
      residualPythonCodeql:false,
      remediation:null,
      reason:'MISSING_CODEQL_CHECKS'
    });
  }
  if(codeqlChecks.some(check=>check.status!=='completed'||check.conclusion!=='success')){
    return freezeResidualResult({
      valid:false,
      residualPythonCodeql:false,
      remediation:null,
      reason:'CODEQL_CHECKS_INCOMPLETE'
    });
  }
  return freezeResidualResult({
    valid:true,
    residualPythonCodeql:false,
    remediation:null,
    reason:'CODEQL_PYTHON_ABSENT'
  });
}
