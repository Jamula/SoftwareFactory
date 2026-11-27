import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {crc32,deflateRawSync} from 'node:zlib';
import {
  readDashboardZipJsonEntries,
  runCli,
  runCliIfDirect,
  verifyDashboardExport
} from '../../tools/engineering-factory/verify-dashboard-export.mjs';

const SCRIPT=resolve('tools/engineering-factory/verify-dashboard-export.mjs');
const TRACE='a'.repeat(32);
const SPAN='b'.repeat(16);

function buildZip(entries,{comment=''}={}){
  const localParts=[];
  const centralParts=[];
  let offset=0;
  for(const entry of entries){
    const nameBuf=Buffer.isBuffer(entry.name)?entry.name:Buffer.from(entry.name,'utf8');
    const localNameBuf=entry.localName===undefined?nameBuf:(Buffer.isBuffer(entry.localName)?entry.localName:Buffer.from(entry.localName,'utf8'));
    const raw=Buffer.isBuffer(entry.data)?entry.data:Buffer.from(entry.data,'utf8');
    const method=entry.method??8;
    const flags=entry.flags??(entry.streaming?0x0008:0);
    const payload=entry.compressed??(method===8?deflateRawSync(raw):raw);
    const actualCrc=entry.crc??(crc32(raw)>>>0);
    const uncompSize=entry.uncompSize??raw.length;
    const compSize=entry.compSize??payload.length;

    const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0);
    local.writeUInt16LE(20,4);
    local.writeUInt16LE(entry.localFlags??flags,6);
    local.writeUInt16LE(entry.localMethod??method,8);
    local.writeUInt32LE(entry.streaming?0:actualCrc,14);
    local.writeUInt32LE(entry.streaming?0:compSize,18);
    local.writeUInt32LE(entry.streaming?0:uncompSize,22);
    local.writeUInt16LE(localNameBuf.length,26);
    local.writeUInt16LE(0,28);

    const descriptor=entry.streaming?Buffer.alloc(16):Buffer.alloc(0);
    if(entry.streaming){
      descriptor.writeUInt32LE(0x08074b50,0);
      descriptor.writeUInt32LE(actualCrc,4);
      descriptor.writeUInt32LE(compSize,8);
      descriptor.writeUInt32LE(uncompSize,12);
    }

    const cen=Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50,0);
    cen.writeUInt16LE(20,4);
    cen.writeUInt16LE(20,6);
    cen.writeUInt16LE(flags,8);
    cen.writeUInt16LE(method,10);
    cen.writeUInt32LE(actualCrc,16);
    cen.writeUInt32LE(compSize,20);
    cen.writeUInt32LE(uncompSize,24);
    cen.writeUInt16LE(nameBuf.length,28);
    cen.writeUInt16LE(0,30);
    cen.writeUInt16LE(0,32);
    cen.writeUInt32LE(entry.localOffset??offset,42);

    localParts.push(local,localNameBuf,payload,descriptor);
    centralParts.push(cen,nameBuf);
    offset+=local.length+localNameBuf.length+payload.length+descriptor.length;
  }
  const cdBuf=Buffer.concat(centralParts);
  const commentBuf=Buffer.from(comment,'utf8');
  const eocd=Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0);
  eocd.writeUInt16LE(entries.length,8);
  eocd.writeUInt16LE(entries.length,10);
  eocd.writeUInt32LE(cdBuf.length,12);
  eocd.writeUInt32LE(offset,16);
  eocd.writeUInt16LE(commentBuf.length,20);
  return Buffer.concat([...localParts,cdBuf,eocd,commentBuf]);
}

function traceDoc({traceId=TRACE,spanId=SPAN,service='softwarefactory-shadow',scope='softwarefactory',wrapped=false}={}){
  const resourceSpans=[{
    resource:{attributes:[{key:'service.name',value:{stringValue:service}}]},
    scopeSpans:[{scope:{name:scope},spans:[{name:'factory.evaluate',traceId,spanId}]}]
  }];
  return wrapped?{data:{resourceSpans}}:{resourceSpans};
}

function logDoc({traceId=TRACE,spanId=SPAN,service='softwarefactory-shadow',scope='softwarefactory',wrapped=false}={}){
  const resourceLogs=[{
    resource:{attributes:[{key:'service.name',value:{stringValue:service}}]},
    scopeLogs:[{scope:{name:scope},logRecords:[{body:{stringValue:'factory.stage.completed'},traceId,spanId}]}]
  }];
  return wrapped?{data:{resourceLogs}}:{resourceLogs};
}

test('verifies stored, deflated, and .NET streaming data-descriptor Aspire export archives',()=>{
  const dir=mkdtempSync(join(tmpdir(),'factory-export-'));
  try{
    const zipPath=join(dir,'export.zip');
    writeFileSync(zipPath,buildZip([
      {name:'consolelogs/synthetic-shadow.txt',data:'STOPPED\n',method:0},
      {name:'resources/synthetic-shadow.json',data:'{"name":"synthetic-shadow"}',method:8,streaming:true},
      {name:'root.json',data:'{}',method:0},
      {name:'traces/synthetic-shadow.json',data:JSON.stringify(traceDoc({traceId:TRACE.toUpperCase()})),method:8,streaming:true},
      {name:'structuredlogs/synthetic-shadow.json',data:JSON.stringify(logDoc({wrapped:true})),method:0}
    ],{comment:'aspire-export'}));
    assert.equal(verifyDashboardExport(zipPath),true);
  }finally{
    rmSync(dir,{recursive:true,force:true});
  }
});

test('fails closed on missing correlation, wrong service or scope, zero IDs, and malformed OTLP payloads',()=>{
  const dir=mkdtempSync(join(tmpdir(),'factory-export-neg-'));
  try{
    const zipPath=join(dir,'bad.zip');
    const cases=[
      [{name:'traces/a.json',data:JSON.stringify(traceDoc())}],
      [
        {name:'traces/a.json',data:JSON.stringify(traceDoc())},
        {name:'structuredlogs/a.json',data:JSON.stringify(logDoc({spanId:'c'.repeat(16)}))}
      ],
      [
        {name:'traces/a.json',data:JSON.stringify(traceDoc({service:'other'}))},
        {name:'structuredlogs/a.json',data:JSON.stringify(logDoc())}
      ],
      [
        {name:'traces/a.json',data:JSON.stringify(traceDoc({scope:'other'}))},
        {name:'structuredlogs/a.json',data:JSON.stringify(logDoc())}
      ],
      [
        {name:'traces/a.json',data:JSON.stringify(traceDoc({traceId:'0'.repeat(32)}))},
        {name:'structuredlogs/a.json',data:JSON.stringify(logDoc({traceId:'0'.repeat(32)}))}
      ],
      [{name:'traces/a.json',data:'{}'}],
      [{name:'traces/a.json',data:JSON.stringify({resourceSpans:[{}]})}],
      [{name:'traces/a.json',data:JSON.stringify({resourceSpans:[{resource:{attributes:'bad'}}]})}],
      [{name:'traces/a.json',data:JSON.stringify({resourceSpans:[{resource:{attributes:[{key:'service.name',value:{stringValue:'softwarefactory-shadow'}}]}}]}) }],
      [{name:'traces/a.json',data:JSON.stringify({resourceSpans:[{resource:{attributes:[{key:'service.name',value:{stringValue:'softwarefactory-shadow'}}]},scopeSpans:[{scope:{name:'softwarefactory'}}]}]}) }]
    ];
    for(const entries of cases){
      writeFileSync(zipPath,buildZip(entries));
      assert.throws(()=>verifyDashboardExport(zipPath));
    }

    const extraRows=traceDoc();
    extraRows.resourceSpans[0].resource.attributes.unshift(null,{key:'x',value:{stringValue:'y'}});
    extraRows.resourceSpans[0].scopeSpans[0].spans.unshift({name:'other',traceId:TRACE,spanId:SPAN},{name:'factory.evaluate',traceId:'bad',spanId:SPAN});
    const extraLogs=logDoc();
    extraLogs.resourceLogs[0].scopeLogs[0].logRecords.unshift({body:{stringValue:'other'},traceId:TRACE,spanId:SPAN});
    writeFileSync(zipPath,buildZip([
      {name:'traces/a.json',data:JSON.stringify(extraRows)},
      {name:'structuredlogs/a.json',data:JSON.stringify(extraLogs)}
    ]));
    assert.equal(verifyDashboardExport(zipPath),true);
  }finally{
    rmSync(dir,{recursive:true,force:true});
  }
});

test('readDashboardZipJsonEntries rejects corrupt, encrypted, path-traversal, unsupported, and oversized ZIP archives',()=>{
  assert.throws(()=>readDashboardZipJsonEntries('not-a-buffer'),/invalid zip archive/);
  assert.throws(()=>readDashboardZipJsonEntries(Buffer.alloc(10)),/invalid zip archive/);
  assert.throws(()=>readDashboardZipJsonEntries(Buffer.alloc(30)),/invalid zip archive/);

  const multiDisk=buildZip([]);
  multiDisk.writeUInt16LE(1,multiDisk.length-18);
  assert.throws(()=>readDashboardZipJsonEntries(multiDisk),/unsupported zip layout/);

  const badCen=buildZip([{name:'traces/a.json',data:'{}'}]);
  const cdOffset=badCen.readUInt32LE(badCen.length-6);
  badCen.writeUInt32LE(0xdeadbeef,cdOffset);
  assert.throws(()=>readDashboardZipJsonEntries(badCen),/corrupt central directory/);

  const trailingCen=Buffer.from(buildZip([]));
  const padded=Buffer.concat([Buffer.alloc(4),trailingCen]);
  padded.writeUInt32LE(4,padded.length-10);
  padded.writeUInt32LE(0,padded.length-6);
  assert.throws(()=>readDashboardZipJsonEntries(padded),/corrupt central directory/);

  const trailingExtra=buildZip([{name:'consolelogs/a.txt',data:'ok'}]);
  const eocdPos=trailingExtra.length-22;
  const origCdSize=trailingExtra.readUInt32LE(eocdPos+12);
  const origCdOff=trailingExtra.readUInt32LE(eocdPos+16);
  const withGap=Buffer.concat([
    trailingExtra.subarray(0,origCdOff+origCdSize),
    Buffer.alloc(4),
    trailingExtra.subarray(eocdPos)
  ]);
  withGap.writeUInt32LE(origCdSize+4,withGap.length-10);
  assert.throws(()=>readDashboardZipJsonEntries(withGap),/corrupt central directory/);

  assert.throws(()=>readDashboardZipJsonEntries(buildZip([{name:'traces/a.json',data:'{}',flags:1}])),/unsupported zip entry/);
  assert.throws(()=>readDashboardZipJsonEntries(buildZip([
    {name:'traces/a.json',data:'{}',localOffset:0},
    {name:'traces/b.json',data:'{}',localOffset:0}
  ])),/unsupported zip entry/);

  const chunkJson=JSON.stringify({resourceSpans:[]})+' '.repeat(3_500_000);
  assert.throws(()=>readDashboardZipJsonEntries(buildZip([
    {name:'traces/1.json',data:chunkJson,method:8},
    {name:'traces/2.json',data:chunkJson,method:8},
    {name:'traces/3.json',data:chunkJson,method:8},
    {name:'traces/4.json',data:chunkJson,method:8},
    {name:'traces/5.json',data:chunkJson,method:8}
  ])),/oversize/);

  for(const unsafe of ['../traces/a.json','/traces/a.json','traces\\a.json','traces/a\0.json','traces/../a.json']){
    assert.throws(()=>readDashboardZipJsonEntries(buildZip([{name:unsafe,data:'{}'}])),/unsafe archive path/);
  }

  assert.throws(()=>readDashboardZipJsonEntries(buildZip([{name:'traces/a.json',data:'{}',uncompSize:4_000_001}])),/oversize/);
  assert.throws(()=>readDashboardZipJsonEntries(buildZip([{name:'traces/a.json',data:'{}',localOffset:999999}])),/corrupt local header/);
  assert.throws(()=>readDashboardZipJsonEntries(buildZip([{name:'traces/a.json',data:'{}',method:8,localMethod:0}])),/corrupt entry payload/);
  assert.throws(()=>readDashboardZipJsonEntries(buildZip([{name:'traces/a.json',data:'{}',flags:0,localFlags:0x0008}])),/corrupt entry payload/);
  assert.throws(()=>readDashboardZipJsonEntries(buildZip([{name:'traces/a.json',localName:'../evil.json',data:'{}'}])),/corrupt entry payload/);
  assert.throws(()=>readDashboardZipJsonEntries(buildZip([{name:'traces/a.json',localName:'../bad/a.json',data:'{}'}])),/corrupt entry payload/);
  assert.throws(()=>readDashboardZipJsonEntries(buildZip([{name:'consolelogs/a.txt',localName:'../evil.txt',data:'ok'}])),/corrupt entry payload/);
  assert.throws(()=>readDashboardZipJsonEntries(buildZip([{name:'traces/a.json',data:'{}',method:99,compressed:Buffer.from('x')}])),/unsupported compression/);
  assert.throws(()=>readDashboardZipJsonEntries(buildZip([{name:'traces/a.json',data:'{}',method:0,crc:12345}])),/entry integrity mismatch/);
  assert.throws(()=>readDashboardZipJsonEntries(buildZip([{name:'traces/a.json',data:'{}',method:0,uncompSize:99}])),/entry integrity mismatch/);

  // Zip-bomb protection: small compressed deflate stream expanding past 4 MB limit
  const bombCompressed=deflateRawSync(Buffer.alloc(4_000_100,0x41));
  assert.throws(()=>readDashboardZipJsonEntries(buildZip([{
    name:'traces/bomb.json',
    data:'{}',
    method:8,
    compressed:bombCompressed,
    compSize:bombCompressed.length,
    uncompSize:2
  }])));
});

test('CLI entrypoint validates arguments, prints generic failure without leaking data, and supports direct execution',()=>{
  const dir=mkdtempSync(join(tmpdir(),'factory-export-cli-'));
  try{
    const validZip=join(dir,'valid.zip');
    writeFileSync(validZip,buildZip([
      {name:'traces/s.json',data:JSON.stringify(traceDoc())},
      {name:'structuredlogs/s.json',data:JSON.stringify(logDoc())}
    ]));
    const out=[],err=[];
    assert.equal(runCli([validZip],{write:v=>out.push(v),fail:v=>err.push(v)}),0);
    assert.deepEqual(out,['Dashboard stored synthetic trace and correlated structured log']);
    assert.deepEqual(err,[]);

    assert.equal(runCli([],{write:v=>out.push(v),fail:v=>err.push(v)}),1);
    assert.deepEqual(err,['Dashboard trace/log readback failed']);

    let code;
    assert.equal(runCliIfDirect('',import.meta.url,[],v=>{code=v;}),false);
    assert.equal(runCliIfDirect(SCRIPT,pathToFileURL('C:/other.mjs').href,[validZip],v=>{code=v;}),false);
    assert.equal(runCliIfDirect(SCRIPT,pathToFileURL(SCRIPT).href,[validZip],v=>{code=v;}),true);
    assert.equal(code,0);

    const secretPath=join(dir,'secret-archive-name.zip');
    const proc=spawnSync(process.execPath,[SCRIPT,secretPath],{encoding:'utf8'});
    assert.equal(proc.status,1);
    assert.equal(proc.stdout,'');
    assert.equal(proc.stderr,'Dashboard trace/log readback failed\n');
    assert.equal(proc.stderr.includes('secret-archive-name'),false);
  }finally{
    rmSync(dir,{recursive:true,force:true});
  }
});
