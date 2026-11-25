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
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
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

import {DatabaseSync} from 'node:sqlite';
import {spawn,spawnSync} from 'node:child_process';

test('fails closed on persistent initialization locks and on a corrupt database', {timeout:10000}, () => {
 const dir=mkdtempSync(join(tmpdir(),'factory-startup-'));
 const path=join(dir,'leases.sqlite');
 const blocker=new DatabaseSync(path);
 try {
  blocker.exec('CREATE TABLE unrelated (id INTEGER); BEGIN; SELECT * FROM unrelated');
  assert.throws(() => openLeaseStore(path), /database is locked/);
  blocker.exec('ROLLBACK');
  openLeaseStore(path).close();

  const brokenPath=join(dir,'broken.sqlite');
  writeFileSync(brokenPath,'not a SQLite database');
  assert.throws(() => openLeaseStore(brokenPath), /not a database/);
 } finally {
  blocker.close();
  rmSync(dir,{recursive:true,force:true});
 }
});

const leaseModule=new URL('../../tools/engineering-factory/lease-transition.mjs',import.meta.url).href;
const runLeaseWorker=(path,key,worker,generation,now)=>new Promise((resolve,reject)=>{
 const source=`import {openLeaseStore} from ${JSON.stringify(leaseModule)};const store=openLeaseStore(process.argv[1]);try{console.log(JSON.stringify(store.apply(process.argv[2],{kind:'acquire',worker:process.argv[3],generation:Number(process.argv[4]),stop:false,ttl:100},Number(process.argv[5]))));}finally{store.close();}`;
 const child=spawn(process.execPath,['--input-type=module','-e',source,path,key,worker,String(generation),String(now)],{stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',settled=false;
 const timeout=setTimeout(()=>{if(!settled){settled=true;child.kill();reject(new Error(`lease worker timed out: ${stderr}`));}},5000);
 child.stdout.setEncoding('utf8').on('data',chunk=>stdout+=chunk);
 child.stderr.setEncoding('utf8').on('data',chunk=>stderr+=chunk);
 child.on('error',error=>{if(!settled){settled=true;clearTimeout(timeout);reject(error);}});
 child.on('close',code=>{if(settled)return;settled=true;clearTimeout(timeout);if(code!==0){reject(new Error(`lease worker exited ${code}: ${stderr}`));return;}try{resolve(JSON.parse(stdout.trim()));}catch(error){reject(new Error(`invalid lease worker output: ${stdout} ${stderr}`,{cause:error}));}});
});
test('competing workers serialize acquisition and locked writes can retry', {timeout:15000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'factory-workers-')),path=join(dir,'leases.sqlite'),key='1:2:'+'a'.repeat(40);
 const lock=new DatabaseSync(path),reader=new DatabaseSync(path);
 try{
  const outcomes=await Promise.all([runLeaseWorker(path,key,'worker-a',0,10),runLeaseWorker(path,key,'worker-b',0,10)]);
  assert.equal(outcomes.filter(x=>x.reason==='ACQUIRED').length,1);
  assert.equal(outcomes.filter(x=>x.reason==='STALE_GENERATION').length,1);
  const row=reader.prepare('SELECT generation,worker FROM shadow_leases WHERE scope=?').get(key);
  assert.equal(row.generation,1);
  const winner=outcomes.find(x=>x.reason==='ACQUIRED').lease.worker;
  lock.exec('BEGIN IMMEDIATE');
  const before=lock.prepare('SELECT generation,worker FROM shadow_leases WHERE scope=?').get(key);
  const denied=await runLeaseWorker(path,key,`${winner}-retry`,1,110);
  assert.equal(denied.reason,'STORE_UNAVAILABLE');
  assert.deepEqual(lock.prepare('SELECT generation,worker FROM shadow_leases WHERE scope=?').get(key),before);
  lock.exec('ROLLBACK');
  const retried=await runLeaseWorker(path,key,`${winner}-retry`,1,110);
  assert.equal(retried.reason,'ACQUIRED');
  assert.equal(retried.lease.generation,2);
 }finally{reader.close();lock.close();rmSync(dir,{recursive:true,force:true});}
});
test('interrupted SQLite transactions preserve committed leases', {timeout:10000},()=>{
 const dir=mkdtempSync(join(tmpdir(),'factory-contention-')),path=join(dir,'leases.sqlite'),key='1:2:'+'a'.repeat(40);
 const store=openLeaseStore(path),lock=new DatabaseSync(path);
 try{
  assert.equal(store.apply(key,r,10).lease.generation,1);
  lock.exec('BEGIN IMMEDIATE');
  assert.equal(store.apply(key,{...r,generation:1},110).reason,'STORE_UNAVAILABLE');
  lock.exec('ROLLBACK');
  assert.equal(store.apply(key,{...r,generation:1},110).lease.generation,2);
  const child=spawnSync(process.execPath,['--input-type=module','-e',
    "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE; UPDATE shadow_leases SET generation=99'); process.exit(17);",path],{timeout:5000,encoding:'utf8'});
  assert.equal(child.status,17,child.stderr);
  assert.equal(store.apply(key,{...r,generation:2},111).reason,'HELD');
  assert.equal(store.apply(key,{...r,generation:2},210).lease.generation,3);
 }finally{lock.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
test('rollback cleanup failure still returns a storage denial',()=>{
 const dir=mkdtempSync(join(tmpdir(),'factory-rollback-')),path=join(dir,'leases.sqlite'),key='1:2:'+'a'.repeat(40);
 const store=openLeaseStore(path);
 let closed=false;
 try{
  const broken={...r,get kind(){store.close();closed=true;throw Error('connection lost');}};
  assert.equal(store.apply(key,broken,10).reason,'STORE_UNAVAILABLE');
 }finally{if(!closed)store.close();rmSync(dir,{recursive:true,force:true});}
});
