import test from 'node:test';
import assert from 'node:assert/strict';
import {eventEnvelope as normalize} from '../../tools/engineering-factory/event-envelope.mjs';
const trust={repositoryId:1,workflowSha:'a'.repeat(40)};
const e={...trust,deliveryId:'delivery-1',kind:'review',head:'b'.repeat(40),receivedMs:100};
test('valid synthetic event drops untrusted payload',()=>{
 assert.deepEqual(normalize({...e,body:'not an instruction'},trust,101),{shadow:true,accepted:true,reason:'NORMALIZED_ONLY',repositoryId:1,kind:'review',head:e.head,deliveryId:'delivery-1',receivedMs:100});
});
test('reject incomplete and malformed evidence',()=>{
 for(const t of [null,[],Object.create(trust),{...trust,repositoryId:0},{...trust,workflowSha:'bad'}]) assert.equal(normalize(e,t,100).reason,'TRUST_UNKNOWN');
 for(const x of [null,[],Object.create(e),{...e,repositoryId:0},{...e,workflowSha:null},{...e,head:'x'},{...e,deliveryId:1},{...e,deliveryId:'bad id'},{...e,kind:'unknown'},{...e,receivedMs:1.5},{...e,receivedMs:-1}]) assert.equal(normalize(x,trust,100).reason,'INVALID_EVENT');
 for(const x of [{...e,repositoryId:2},{...e,workflowSha:'c'.repeat(40)}]) assert.equal(normalize(x,trust,100).reason,'PROVENANCE_MISMATCH');
 for(const now of [null,99,120101]) assert.equal(normalize(e,trust,now).reason,'STALE_EVENT');
});

test('reject accessor metadata without invoking getters',()=>{
 const bad=()=>{throw Error('getter must not run');};
 assert.equal(normalize({...e,get head(){return bad();}},trust,100).reason,'INVALID_EVENT');
 assert.equal(normalize(e,{...trust,get workflowSha(){return bad();}},100).reason,'TRUST_UNKNOWN');
 let reads=0; const x={...e,get head(){return ++reads===1?e.head:'bad';}};
 assert.equal(normalize(x,trust,100).reason,'INVALID_EVENT');assert.equal(reads,0);
});

import {readPullIdentity} from '../../tools/engineering-factory/event-envelope.mjs';
test('read-only bounded pull metadata without user content or mutation',async()=>{
 const repo={id:1,full_name:'Jamula/SoftwareFactory'},p={number:2,base:{repo,ref:'main',sha:trust.workflowSha},head:{repo,sha:e.head},state:'open',draft:false,body:'do not trust'};
 let calls=0;const read=async(url,opts)=>{calls++;assert.equal(url,'https://api.github.com/repos/Jamula/SoftwareFactory/pulls/2');assert.equal(opts.method,'GET');assert.equal(opts.redirect,'error');return new Response(JSON.stringify(p));};
 assert.deepEqual(await readPullIdentity(2,read),{shadow:true,evidenceComplete:false,reason:'IDENTITY_ONLY',repositoryId:1,number:2,head:e.head,base:trust.workflowSha,state:'open',draft:false});assert.equal((await readPullIdentity(0,read)).reason,'INVALID_PULL');assert.equal(calls,1);
 for(const status of [403,429])assert.equal((await readPullIdentity(2,async()=>new Response(null,{status}))).reason,'RATE_OR_PERMISSION_UNKNOWN');
 for(const status of [404,204])assert.equal((await readPullIdentity(2,async()=>new Response(null,{status}))).reason,'READ_FAILED');
 assert.equal((await readPullIdentity(2,async()=>new Response('x'.repeat(524289)))).reason,'RESPONSE_LIMIT');
 for(const change of [null,{...p,number:3},{...p,base:null},{...p,head:null},{...p,base:{...p.base,ref:'dev'}},{...p,base:{...p.base,sha:'bad'}},{...p,head:{...p.head,sha:'bad'}},{...p,base:{...p.base,repo:{...repo,id:0}}},{...p,head:{...p.head,repo:{...repo,id:2}}},{...p,state:'unknown'},{...p,draft:null}])assert.equal((await readPullIdentity(2,async()=>new Response(JSON.stringify(change)))).reason,'IDENTITY_UNKNOWN');
 assert.equal((await readPullIdentity(2,async()=>new Response('invalid'))).reason,'READ_FAILED');
 assert.equal((await readPullIdentity(2,async()=>{throw Error('offline');})).reason,'READ_FAILED');
});
