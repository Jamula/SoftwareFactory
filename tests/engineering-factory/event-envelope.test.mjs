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
