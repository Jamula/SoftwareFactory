import {pathToFileURL} from 'node:url';
import {smoke,readInventory} from './shadow-runtime.mjs';
import {reconcilePullTrigger} from './event-envelope.mjs';
import {reconcileIssueTrigger} from './issue-event.mjs';
import {telemetrySummary,createExecutionReceipt} from './telemetry.mjs';

export {telemetrySummary};

const repositoryId=1471342715;
let localReceiptSequence=0;
const nextLocalSequence=()=>{
  localReceiptSequence=(localReceiptSequence%1000000000)+1;
  return localReceiptSequence;
};
const commandSpecs=new Map([
  ['--smoke',{stage:'evaluate',tag:'smoke',syntheticOnly:true}],
  ['--inventory',{stage:'reconcile',tag:'inventory',syntheticOnly:false}],
  ['--reconcile-pull',{stage:'reconcile',tag:'reconcile-pull',syntheticOnly:false}],
  ['--reconcile-issue',{stage:'reconcile',tag:'reconcile-issue',syntheticOnly:false}]
]);

function parseArgs(args) {
  let command=null,emitReceipt=false;
  for(const arg of args) {
    if(arg==='--receipt') {
      if(emitReceipt) return null;
      emitReceipt=true;
    } else if(commandSpecs.has(arg)) {
      if(command!==null) return null;
      command=arg;
    } else {
      return null;
    }
  }
  return {command:command??'--smoke',emitReceipt};
}

function safeClock(clock) {
  try {
    const value=clock();
    return Number.isSafeInteger(value)&&value>=0?value:null;
  } catch {
    return null;
  }
}

function resolveReceiptSource(env,spec,finishedAt,injectedReceiptId) {
  const hostedRunner=env?.RUNNER_ENVIRONMENT==='github-hosted';
  const runId=typeof env?.GITHUB_RUN_ID==='string'&&/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID)?env.GITHUB_RUN_ID:null;
  const rawAttempt=env?.GITHUB_RUN_ATTEMPT??'1';
  const attempt=typeof rawAttempt==='string'&&/^[1-9][0-9]{0,3}$/.test(rawAttempt)?rawAttempt:null;
  const discriminator=()=>finishedAt!==null?`${finishedAt}-${nextLocalSequence()}`:`${nextLocalSequence()}`;
  if(spec.syntheticOnly) {
    const defaultId=hostedRunner&&runId&&attempt
      ?`gh-${runId}-${attempt}-${spec.tag}`
      :`synthetic-${spec.tag}-${discriminator()}`;
    return {source:'synthetic',receiptId:injectedReceiptId??defaultId};
  }
  if(env?.GITHUB_ACTIONS==='true') {
    if(!hostedRunner||env.GITHUB_REPOSITORY_ID!==String(repositoryId)||!runId||!attempt)
      return {source:'invalid',receiptId:'invalid'};
    return {source:'github-hosted',receiptId:injectedReceiptId??`gh-${runId}-${attempt}-${spec.tag}`};
  }
  return {source:'synthetic',receiptId:injectedReceiptId??`local-${spec.tag}-${discriminator()}`};
}

async function observedResult(observe,stage,work) {
  let result;
  await observe(stage,async()=>{
    result=await work();
    return telemetrySummary(result);
  });
  return result;
}

function buildStageReceipt({env,spec,startedAt,finishedAt,result,receiptId:injectedId,quota,cost,humanTouches,correlation}) {
  const {source,receiptId}=resolveReceiptSource(env,spec,finishedAt,injectedId);
  const durationMs=startedAt!==null&&finishedAt!==null&&finishedAt>=startedAt?finishedAt-startedAt:null;
  return createExecutionReceipt({
    source,
    repositoryId,
    receiptId,
    observedMs:finishedAt,
    stage:spec.stage,
    durationMs,
    result,
    quota,
    cost,
    humanTouches,
    correlation
  });
}

// The injected I/O and inventory functions permit deterministic offline CLI tests.
export async function run(args,{write=console.log,fail=console.error,inventory=readInventory,replay=smoke,
  reconcile=reconcilePullTrigger,reconcileIssue=reconcileIssueTrigger,env=process.env,
  observe=(_stage,work)=>work(),clock=Date.now,writeReceipt,receiptId,quota=null,cost=null,
  humanTouches=null,correlation=null}={}) {
  const parsed=parseArgs(args);
  if(!parsed) {
    fail('Usage: node tools/engineering-factory/run.mjs [--smoke|--inventory|--reconcile-pull|--reconcile-issue] [--receipt]');
    return 2;
  }
  const spec=commandSpecs.get(parsed.command);
  const wantsReceipt=parsed.emitReceipt||typeof writeReceipt==='function';
  const startedAt=wantsReceipt?safeClock(clock):null;
  try {
    const handlers={
      '--smoke':async()=>replay(),
      '--inventory':async()=>inventory(),
      '--reconcile-pull':async()=>reconcile(env),
      '--reconcile-issue':async()=>reconcileIssue(env)
    };
    const result=await observedResult(observe,spec.stage,handlers[parsed.command]);
    const exitCode=parsed.command==='--smoke'
      ?(result.reason==='SHADOW_PLAN'&&Array.isArray(result.ready)&&result.ready.join(',')==='1,2'?0:1)
      :0;
    const payload=parsed.command==='--smoke'
      ?{mode:'synthetic',...result,liveDispatch:false,liveMerge:false}
      :result;
    if(!wantsReceipt) {
      write(JSON.stringify(payload));
      return exitCode;
    }
    const finishedAt=safeClock(clock);
    const receipt=buildStageReceipt({env,spec,startedAt,finishedAt,result,receiptId,quota,cost,humanTouches,correlation});
    if(parsed.emitReceipt) {
      write(JSON.stringify(receipt));
      if(typeof writeReceipt==='function') {
        try {writeReceipt(receipt);} catch {}
      }
      return receipt.valid?exitCode:1;
    }
    write(JSON.stringify(payload));
    try {writeReceipt(receipt);} catch {}
    return exitCode;
  } catch {
    if(wantsReceipt) {
      const finishedAt=safeClock(clock);
      const receipt=buildStageReceipt({
        env,spec,startedAt,finishedAt,result:{reason:'READ_FAILED'},receiptId,quota,cost,humanTouches,correlation
      });
      if(parsed.emitReceipt) write(JSON.stringify(receipt));
      if(typeof writeReceipt==='function') {
        try {writeReceipt(receipt);} catch {}
      }
    }
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
