import {types} from 'node:util';
const time=v=>Number.isSafeInteger(v)&&v>=0;
const own=(v,ks)=>v!==null&&typeof v==='object'&&!types.isProxy(v)&&!Array.isArray(v)&&ks.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)??{},'value'));
const unknown=reason=>({known:false,reason});
// First publication is obtained from complete trusted timeline evidence, never updated_at.
// Pure measurement; no scheduling, write, or acceptance authority.
export function prLifecycle(e){
 const fields=['created','initialDraft','firstPublished','historyComplete','merged','mainVerified','observed'];
 if(!own(e,fields)||e.historyComplete!==true||typeof e.initialDraft!=='boolean'||!time(e.created)||!time(e.observed)||e.observed<e.created)return unknown('HISTORY_UNKNOWN');
 const pub=e.initialDraft?e.firstPublished:e.created;
 if((!e.initialDraft&&e.firstPublished!==e.created)||(pub!==null&&(!time(pub)||pub<e.created||pub>e.observed)))return unknown('PUBLICATION_UNKNOWN');
 if(e.merged!==null&&(!time(e.merged)||pub===null||e.merged<pub||e.merged>e.observed))return unknown('MERGE_UNKNOWN');
 if(e.mainVerified!==null&&(!time(e.mainVerified)||e.merged===null||e.mainVerified<e.merged||e.mainVerified>e.observed))return unknown('VERIFICATION_UNKNOWN');
 return {known:true,source:'timeline',censored:e.merged===null,
  draftToPublishMs:pub===null?null:pub-e.created,
  openDraftAgeMs:pub===null?e.observed-e.created:null,
  publishToMergeMs:e.merged===null?null:e.merged-pub,
  openPublishedAgeMs:pub!==null&&e.merged===null?e.observed-pub:null,
  createdToMergeMs:e.merged===null?null:e.merged-e.created,
  openAgeMs:e.merged===null?e.observed-e.created:null,
  mergeToVerifiedMs:e.mainVerified===null?null:e.mainVerified-e.merged,
  verificationPendingAgeMs:e.merged!==null&&e.mainVerified===null?e.observed-e.merged:null};
}
