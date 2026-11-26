import {pathToFileURL} from 'node:url';
import {smoke,readInventory} from './shadow-runtime.mjs';
import {reconcilePullTrigger} from './event-envelope.mjs';
import {reconcileIssueTrigger} from './issue-event.mjs';

const reasonLabels=new Map([
  ['SHADOW_PLAN','NONE'],['SHADOW_ELIGIBLE','NONE'],['PULL_IDENTITY_MATCHED','NONE'],
  ['ISSUE_IDENTITY_MATCHED','NONE'],['IDENTITY_ONLY','NONE'],
  ['STOPPED','POLICY'],['ACTIVE_OWNERSHIP_CONFLICT','POLICY'],
  ['TRUST_UNKNOWN','SECURITY'],['PROVENANCE_MISMATCH','SECURITY'],
  ['STALE_EVENT','STALE'],['HEAD_CHANGED','STALE'],
  ['INVALID_ISSUE','INVALID_EVIDENCE'],['INVALID_PULL','INVALID_EVIDENCE'],
  ['INVALID_EVENT','INVALID_EVIDENCE'],['IDENTITY_UNKNOWN','INVALID_EVIDENCE'],
  ['RESPONSE_LIMIT','INVALID_EVIDENCE'],['INVALID_TASKS','INVALID_EVIDENCE'],
  ['UNKNOWN_DEPENDENCY','DEPENDENCY'],['DEPENDENCY_CYCLE','DEPENDENCY'],
  ['DEPENDENCIES_BLOCKED','DEPENDENCY'],['READ_FAILED','OTHER'],
  ['RATE_OR_PERMISSION_UNKNOWN','OTHER']
]);

function telemetrySummary(result) {
  const code=typeof result?.reason==='string'?result.reason:'';
  const reason=code?reasonLabels.get(code)??'OTHER':'NONE';
  let outcome='unknown';
  if(code==='READ_FAILED') outcome='failed';
  else if(result?.reconciled===true) outcome='unknown';
  else if(result?.reconciled===false) outcome='blocked';
  else if(code==='SHADOW_PLAN'&&Array.isArray(result?.ready)&&result.ready.length>0) outcome='eligible';
  return {outcome,reason};
}

async function observedResult(observe,stage,work) {
  let result;
  await observe(stage,async()=>{
    result=await work();
    return telemetrySummary(result);
  });
  return result;
}

// The injected I/O and inventory functions permit deterministic offline CLI tests.
export async function run(args,{write=console.log,fail=console.error,inventory=readInventory,replay=smoke,
  reconcile=reconcilePullTrigger,reconcileIssue=reconcileIssueTrigger,env=process.env,
  observe=(_stage,work)=>work()}={}) {
  try {
    if(args.length===0 || (args.length===1 && args[0]==='--smoke')) {
      const result=await observedResult(observe,'evaluate',async()=>replay());
      write(JSON.stringify({mode:'synthetic',...result,liveDispatch:false,liveMerge:false}));
      return result.reason==='SHADOW_PLAN' && result.ready.join(',')==='1,2' ? 0 : 1;
    }
    if(args.length===1 && args[0]==='--inventory') {
      write(JSON.stringify(await observedResult(observe,'reconcile',async()=>inventory())));
      return 0;
    }
    if(args.length===1 && args[0]==='--reconcile-pull') {
      write(JSON.stringify(await observedResult(observe,'reconcile',async()=>reconcile(env))));
      return 0;
    }
    if(args.length===1 && args[0]==='--reconcile-issue') {
      write(JSON.stringify(await observedResult(observe,'reconcile',async()=>reconcileIssue(env))));
      return 0;
    }
    fail('Usage: node tools/engineering-factory/run.mjs [--smoke|--inventory|--reconcile-pull|--reconcile-issue]');
    return 2;
  } catch {
    fail('FACTORY_RUN_FAILED');
    return 1;
  }
}
export async function runCliIfDirect(entrypoint,moduleUrl,args,setExitCode=value=>{process.exitCode=value;}) {
  if(entrypoint && pathToFileURL(entrypoint).href===moduleUrl) {
    setExitCode(await run(args));
    return true;
  }
  return false;
}
await runCliIfDirect(process.argv[1],import.meta.url,process.argv.slice(2));
