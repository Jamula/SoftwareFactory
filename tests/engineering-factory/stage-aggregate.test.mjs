import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregateStage as aggregate} from '../../tools/engineering-factory/stage-aggregate.mjs';
const q={repositoryId:1,stage:'review',from:10,to:20,complete:true,source:'synthetic',observedMs:20,nowMs:22,maxAgeMs:10};
const r={id:'sample-1',repositoryId:1,stage:'review',at:10,duration:5,source:'synthetic'};
test('bounded window and nearest-rank percentiles',()=>{
 const rows=[r,{...r,id:'sample-2',at:19,duration:20},{...r,id:'sample-3',at:20},{...r,id:'sample-4',at:9},{...r,id:'sample-5',stage:'ci'}];
 assert.deepEqual(aggregate(rows,q),{state:'synthetic',reason:'MEASURED_FIXTURE',sampleCount:2,p50:5,p95:20});
 assert.equal(aggregate([],q).reason,'NO_SAMPLES');
 assert.equal(aggregate([{...r,duration:0}],q).p50,0);
});
test('invalid, incomplete and cross-scope evidence fails closed',()=>{
 for(const x of [null,[],Object.create(q),{...q,repositoryId:0},{...q,stage:'bad'},{...q,from:-1},{...q,to:1.5},{...q,to:10},{...q,complete:false},{...q,source:'live'}]) assert.equal(aggregate([r],x).reason,'SCOPE_UNKNOWN');
 for(const x of [null,new Array(1),Array(10001).fill(r)]) assert.equal(aggregate(x,q).reason,'INVALID_ROWS');
 for(const x of [null,Object.create(r),{...r,id:1},{...r,id:'bad id'},{...r,repositoryId:2},{...r,stage:'bad'},{...r,at:-1},{...r,duration:-1},{...r,source:'live'}]) assert.equal(aggregate([x],q).reason,'INVALID_ROW');
 assert.equal(aggregate([r,r],q).reason,'DUPLICATE_EVIDENCE');
});

test('freshness is about snapshot acquisition, not historical sample age',()=>{
 assert.equal(aggregate([r],{...q,nowMs:31}).reason,'STALE_EVIDENCE');
 for(const x of [{observedMs:19},{observedMs:23},{nowMs:null},{maxAgeMs:0},{observedMs:undefined}]) assert.equal(aggregate([r],{...q,...x}).reason,'FRESHNESS_UNKNOWN');
 assert.equal(aggregate([r],{...q,nowMs:30}).sampleCount,1);
 const oversized=new Array(10001);Object.defineProperty(oversized,0,{get(){throw Error('must not read oversized array');}});
 assert.equal(aggregate(oversized,q).reason,'INVALID_ROWS');
});
