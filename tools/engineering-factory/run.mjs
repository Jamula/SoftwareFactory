import {smoke,readInventory} from './shadow-runtime.mjs';
try {
  const args=process.argv.slice(2);
  if(args.length===0 || (args.length===1 && args[0]==='--smoke')) {
    const result=smoke();
    console.log(JSON.stringify({mode:'synthetic',...result,liveDispatch:false,liveMerge:false}));
    if(result.reason!=='SHADOW_PLAN'||result.ready.join(',')!=='1,2') process.exitCode=1;
  } else if(args.length===1 && args[0]==='--inventory') {
    console.log(JSON.stringify(await readInventory()));
  } else {
    console.error('Usage: node tools/engineering-factory/run.mjs [--smoke|--inventory]');
    process.exitCode=2;
  }
} catch {
  console.error('FACTORY_RUN_FAILED');
  process.exitCode=1;
}
