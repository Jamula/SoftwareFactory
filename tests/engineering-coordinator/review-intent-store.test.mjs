import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openReviewIntentStore} from '../../tools/engineering-coordinator/review-intent-store.mjs';

const key='example/synthetic:1:'+'a'.repeat(40);
test('one durable claim across connections and restarts; no automatic release',()=>{
 const dir=mkdtempSync(join(tmpdir(),'review-intent-'));
 const path=join(dir,'intent.sqlite');
 let a=openReviewIntentStore(path); const b=openReviewIntentStore(path);
 try {
  assert.equal(a.claim(key),true);
  assert.equal(b.claim(key),false);
  a.close();a=openReviewIntentStore(path);
  assert.equal(a.claim(key),false);
  assert.equal(b.claim(key.replace(':1:',':2:')),true);
  assert.equal(a.claim(key.replace('a'.repeat(40),'b'.repeat(40))),true);
 } finally {a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
test('invalid or closed store fails closed and storage is bounded',()=>{
 const a=openReviewIntentStore(':memory:');
 for(const k of [null,'x'.repeat(301),'bad','Example/synthetic:1:'+'a'.repeat(40)])assert.equal(a.claim(k),false);
 for(let i=1;i<=10000;i++)assert.equal(a.claim('example/synthetic:'+i+':'+'a'.repeat(40)),true);
 assert.equal(a.claim('example/synthetic:10001:'+'a'.repeat(40)),false);
 a.close();assert.equal(a.claim(key),false);
});
test('incompatible schema fails construction',()=>{
 const dir=mkdtempSync(join(tmpdir(),'review-intent-schema-'));
 const path=join(dir,'intent.sqlite');
 const db=new DatabaseSync(path);
 try {db.exec('CREATE TABLE coordinator_review_intents (unrelated INTEGER)');assert.throws(()=>openReviewIntentStore(path));}
 finally {db.close();rmSync(dir,{recursive:true,force:true});}
});
