import {pathToFileURL} from 'node:url';
import {smoke,readInventory} from './shadow-runtime.mjs';

// The injected I/O and inventory functions permit deterministic offline CLI tests.
export async function run(args,{write=console.log,fail=console.error,inventory=readInventory,replay=smoke}={}) {
  try {
    if(args.length===0 || (args.length===1 && args[0]==='--smoke')) {
      const result=replay();
      write(JSON.stringify({mode:'synthetic',...result,liveDispatch:false,liveMerge:false}));
      return result.reason==='SHADOW_PLAN' && result.ready.join(',')==='1,2' ? 0 : 1;
    }
    if(args.length===1 && args[0]==='--inventory') {
      write(JSON.stringify(await inventory()));
      return 0;
    }
    fail('Usage: node tools/engineering-factory/run.mjs [--smoke|--inventory]');
    return 2;
  } catch {
    fail('FACTORY_RUN_FAILED');
    return 1;
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)
  process.exitCode=await run(process.argv.slice(2));
