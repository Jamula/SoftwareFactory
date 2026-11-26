import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('hosted pilot compares complete response bytes before success',{skip:process.platform==='win32'},()=>{
 const yaml=readFileSync(new URL('../../.github/workflows/copilot-hosted-pilot.yml',import.meta.url),'utf8');
 const start=yaml.indexOf('          # Exact bytes only:');
 const end=yaml.indexOf("          printf '%s\\n' 'COPILOT_HOSTED_SYNTHETIC_RESPONSE_VERIFIED'",start);
 assert.ok(start>=0&&end>start);
 const guard=yaml.slice(start,end).split('\n').map(line=>line.replace(/^          /,'')).join('\n');
 const root=mkdtempSync(join(tmpdir(),'copilot-pilot-receipt-'));
 const marker='FACTORY_COPILOT_PILOT_5';
 try{
  for(const [response,pass] of [[marker,true],[marker+'\n',true],[marker+'\nextra',false],[marker+'\nextra\n',false],['prefix\n'+marker,false],[marker+'\n\n',false],[marker+'\0',false],[marker+' ',false],[marker+'\r\n',false],['',false]]){
   writeFileSync(join(root,'result'),response);
   const run=spawnSync('bash',['--noprofile','--norc','-c',guard],{env:{...process.env,root},encoding:'utf8'});
   assert.equal(run.error,undefined);
   assert.equal(run.status,pass?0:1,JSON.stringify(response));
  }
  rmSync(join(root,'result'));
  assert.equal(spawnSync('bash',['--noprofile','--norc','-c',guard],{env:{...process.env,root}}).status,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});
