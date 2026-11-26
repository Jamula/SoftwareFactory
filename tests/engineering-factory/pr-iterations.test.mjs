import test from 'node:test';
import assert from 'node:assert/strict';
import {prIterations as measure} from '../../tools/engineering-factory/pr-iterations.mjs';
const h='a'.repeat(40),j='b'.repeat(40);
const a=(id,head,at,kind,cause,passed)=>({id,head,at,kind,cause,passed});
const base=()=>({complete:true,observed:100,merged:true,finalHead:h,attempts:[a('1',h,1,'candidate','initial',true)]});
test('first candidate and queue checks are separate',()=>{
 const e=base();assert.equal(measure(e).firstPass,true);
 e.attempts.push(a('2',h,2,'queue','queueRevalidation',true));const r=measure(e);assert.equal(r.candidateRounds,1);assert.equal(r.queueRevalidations,1);assert.equal(r.firstPass,true);
 e.merged=false;assert.equal(measure(e).firstPass,null);assert.equal(measure(e).censored,true);
});
test('review and CI repair are distinct from same-head infrastructure retries',()=>{
 const e=base();e.finalHead=j;e.attempts[0].passed=false;e.attempts.push(a('2',h,2,'retry','infrastructure',false),a('3',j,3,'candidate','reviewRepair',true));
 const r=measure(e);assert.equal(r.candidateRounds,2);assert.equal(r.reworkRounds,1);assert.equal(r.infrastructureRetries,1);assert.equal(r.causes.reviewRepair,1);assert.equal(r.firstPass,false);
 e.attempts[2].cause='ciRepair';assert.equal(measure(e).causes.ciRepair,1);
 e.attempts[2].cause='baseRefresh';assert.equal(measure(e).causes.baseRefresh,1);
});
test('unknown, duplicate and stale evidence is rejected',()=>{
 for(const x of [null,{...base(),complete:false},{...base(),observed:-1},{...base(),merged:null},{...base(),finalHead:'bad'},{...base(),attempts:[]},{...base(),attempts:new Array(1)},new Proxy(base(),{})])assert.equal(measure(x).reason,'HISTORY_UNKNOWN');
 for(const x of [{id:'1'},{head:'bad'},{at:0},{at:101},{kind:'bad'},{passed:null}]){const e=base();e.attempts.push({...a('2',h,2,'retry','infrastructure',true),...x});assert.equal(measure(e).reason,'ATTEMPT_UNKNOWN');}
 for(const x of [a('2',h,2,'candidate','reviewRepair',true),a('2',j,2,'candidate','initial',true),a('2',j,2,'candidate','bad',true)]){const e=base();e.attempts.push(x);assert.equal(measure(e).reason,'CANDIDATE_UNKNOWN');}
 for(const x of [a('2',j,2,'retry','infrastructure',true),a('2',h,2,'retry','bad',true)]){const e=base();e.attempts.push(x);assert.equal(measure(e).reason,'RETRY_UNKNOWN');}
 for(const x of [a('2',j,2,'queue','queueRevalidation',true),a('2',h,2,'queue','bad',true)]){const e=base();e.attempts.push(x);assert.equal(measure(e).reason,'QUEUE_UNKNOWN');}
 const e=base();e.finalHead=j;assert.equal(measure(e).reason,'FINAL_EVIDENCE_UNKNOWN');
 const f=base();f.attempts[0].passed=false;assert.equal(measure(f).reason,'FINAL_EVIDENCE_UNKNOWN');
 const k=base();Object.defineProperty(k.attempts,'0',{get(){throw Error('getter');}});assert.equal(measure(k).reason,'HISTORY_UNKNOWN');
});

test('same-head infrastructure retry does not lower candidate first-pass yield',()=>{
 const e=base();e.attempts[0].passed=false;e.attempts.push(a('2',h,2,'retry','infrastructure',true));const result=measure(e);assert.equal(result.firstPass,true);assert.equal(result.infrastructureRetries,1);
});
test('candidate cause must be a string without coercion',()=>{
 for(const cause of [['reviewRepair'],{toString(){throw Error('coercion');}}]){const e=base();e.attempts.push(a('2',j,2,'candidate',cause,true));assert.equal(measure(e).reason,'CANDIDATE_UNKNOWN');}
});
