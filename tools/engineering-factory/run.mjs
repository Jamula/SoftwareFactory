import {pathToFileURL} from 'node:url';
import {smoke,readInventory} from './shadow-runtime.mjs';
import {reconcilePullTrigger} from './event-envelope.mjs';
import {reconcileIssueTrigger} from './issue-event.mjs';

// The injected I/O and inventory functions permit deterministic offline CLI tests.
export async function run(args,{write=console.log,fail=console.error,inventory=readInventory,replay=smoke,
  reconcile=reconcilePullTrigger,reconcileIssue=reconcileIssueTrigger,env=process.env,
  observe=(_stage,work)=>work()}={}) {
  try {
    if(args.length===0 || (args.length===1 && args[0]==='--smoke')) {
      const result=await observe('evaluate',async()=>replay());
      write(JSON.stringify({mode:'synthetic',...result,liveDispatch:false,liveMerge:false}));
      return result.reason==='SHADOW_PLAN' && result.ready.join(',')==='1,2' ? 0 : 1;
    }
    if(args.length===1 && args[0]==='--inventory') {
      write(JSON.stringify(await observe('reconcile',async()=>inventory())));
      return 0;
    }
    if(args.length===1 && args[0]==='--reconcile-pull') {
      write(JSON.stringify(await observe('reconcile',async()=>reconcile(env))));
      return 0;
    }
    if(args.length===1 && args[0]==='--reconcile-issue') {
      write(JSON.stringify(await observe('reconcile',async()=>reconcileIssue(env))));
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
