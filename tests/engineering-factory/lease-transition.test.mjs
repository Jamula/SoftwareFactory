import test from 'node:test';
import assert from 'node:assert/strict';
import {leaseTransition as step} from '../../tools/engineering-factory/lease-transition.mjs';
const r={kind:'acquire',worker:'worker-a',generation:0,stop:false,ttl:100};
const l={worker:'worker-a',generation:1,expires:110};
test('acquire, deny duplicate, release and recover expired generation',()=>{
 assert.deepEqual(step(null,r,10).lease,l);
 assert.equal(step(l,{...r,generation:1},11).reason,'HELD');
 assert.equal(step(l,r,11).reason,'STALE_GENERATION');
 assert.equal(step(l,{...r,kind:'release',generation:1},11).lease.expires,11);
 assert.equal(step(l,{...r,worker:'worker-b',generation:1},110).lease.generation,2);
 for(const x of [null,{...l,worker:'other'},{...l,expires:10}]) assert.equal(step(x,{...r,kind:'release',generation:x===null?0:1},10).reason,'NOT_HELD');
});
test('fail closed on invalid fields, stop and overflow',()=>{
 for(const x of [null,[],Object.create(r),{...r,worker:null},{...r,generation:1.5},{...r,generation:-1},{...r,kind:'bad'},{...r,ttl:0},{...r,ttl:120001}]) assert.equal(step(null,x,10).reason,'INVALID_REQUEST');
 for(const n of [null,-1,Number.MAX_SAFE_INTEGER]) assert.equal(step(null,r,n).reason,'INVALID_REQUEST');
 assert.equal(step(null,{...r,stop:true},10).reason,'STOPPED');
 for(const x of [[],Object.create(l),{...l,worker:null},{...l,generation:0},{...l,expires:null},{...l,expires:-1}]) assert.equal(step(x,r,10).reason,'INVALID_LEASE');
 assert.equal(step({...l,generation:Number.MAX_SAFE_INTEGER},{...r,generation:Number.MAX_SAFE_INTEGER},110).reason,'INVALID_REQUEST');
});

test('acquire requires its own TTL',()=>{
 const {ttl,...rest}=r;const inherited=Object.assign(Object.create({ttl}),rest);
 assert.equal(step(null,inherited,10).reason,'INVALID_REQUEST');
 assert.equal(step(null,rest,10).reason,'INVALID_REQUEST');
});

import {openLeaseStore} from '../../tools/engineering-factory/lease-transition.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('durable local lease survives restart and denies stale workers',()=>{
 const dir=mkdtempSync(join(tmpdir(),'factory-lease-'));
 const path=join(dir,'leases.sqlite'),key='1:2:'+'a'.repeat(40);
 let a=openLeaseStore(path),b=openLeaseStore(path);
 try {
  assert.equal(a.apply(key,r,10).lease.generation,1);
  assert.equal(b.apply(key,r,11).reason,'STALE_GENERATION');
  assert.equal(b.apply(key,{...r,generation:1},11).reason,'HELD');
  a.close();a=openLeaseStore(path);
  assert.equal(a.apply(key,{...r,worker:'worker-b',generation:1},110).lease.generation,2);
  assert.equal(b.apply(key,{...r,generation:1,kind:'release'},111).reason,'STALE_GENERATION');
  assert.equal(a.apply('2:2:'+'a'.repeat(40),r,10).lease.generation,1);
  assert.equal(a.apply(key,{...r,stop:true},111).reason,'STOPPED');
  for(const x of [null,'bad'])assert.equal(a.apply(x,r,10).reason,'INVALID_SCOPE');
  const bad={...r,generation:2,get kind(){throw Error('invalid request');}};
  assert.equal(a.apply(key,bad,111).reason,'STORE_UNAVAILABLE');
  assert.equal(b.apply(key,{...r,generation:2},111).reason,'HELD');
  a.close();assert.equal(a.apply(key,r,10).reason,'STORE_UNAVAILABLE');a=openLeaseStore(path);
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
