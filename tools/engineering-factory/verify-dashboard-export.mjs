// Runner-only assertion of actual Aspire dashboard ZIP export; never print telemetry or secrets.
import {pathToFileURL} from 'node:url';
import {crc32,inflateRawSync} from 'node:zlib';
import {readBoundedFile} from './verify-dashboard-api.mjs';

const MAX_ARCHIVE_BYTES=16_000_000;
const MAX_TOTAL_UNCOMPRESSED_BYTES=16_000_000;
const MAX_ENTRY_BYTES=4_000_000;
const MAX_ENTRIES=512;
const EOCD_SIG=0x06054b50;
const CEN_SIG=0x02014b50;
const LOC_SIG=0x04034b50;

const isExactStringValue=(value,expected)=>
  value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===1&&Object.hasOwn(value,'stringValue')&&value.stringValue===expected;

function findEocdOffset(buffer){
  const minOffset=Math.max(0,buffer.length-22-0xffff);
  for(let offset=buffer.length-22;offset>=minOffset;offset--){
    if(buffer.readUInt32LE(offset)===EOCD_SIG&&offset+22+buffer.readUInt16LE(offset+20)===buffer.length)
      return offset;
  }
  throw Error('invalid zip archive');
}

export function readDashboardZipJsonEntries(buffer){
  if(!Buffer.isBuffer(buffer)||buffer.length<22||buffer.length>MAX_ARCHIVE_BYTES)throw Error('invalid zip archive');
  const eocd=findEocdOffset(buffer);
  const disk=buffer.readUInt16LE(eocd+4);
  const cdDisk=buffer.readUInt16LE(eocd+6);
  const diskEntries=buffer.readUInt16LE(eocd+8);
  const totalEntries=buffer.readUInt16LE(eocd+10);
  const cdSize=buffer.readUInt32LE(eocd+12);
  const cdOffset=buffer.readUInt32LE(eocd+16);
  if(disk!==0||cdDisk!==0||diskEntries!==totalEntries||totalEntries>MAX_ENTRIES||
     cdSize===0xffffffff||cdOffset===0xffffffff||cdOffset+cdSize>eocd)
    throw Error('unsupported zip layout');
  const decoder=new TextDecoder('utf-8',{fatal:true});
  const entries=[];
  const seenOffsets=new Set();
  let totalUncompressed=0;
  let pos=cdOffset;
  const cdEnd=cdOffset+cdSize;
  for(let i=0;i<totalEntries;i++){
    if(pos+46>cdEnd||buffer.readUInt32LE(pos)!==CEN_SIG)throw Error('corrupt central directory');
    const flags=buffer.readUInt16LE(pos+8);
    const method=buffer.readUInt16LE(pos+10);
    const expectedCrc=buffer.readUInt32LE(pos+16);
    const compSize=buffer.readUInt32LE(pos+20);
    const uncompSize=buffer.readUInt32LE(pos+24);
    const nameLen=buffer.readUInt16LE(pos+28);
    const extraLen=buffer.readUInt16LE(pos+30);
    const commentLen=buffer.readUInt16LE(pos+32);
    const localOffset=buffer.readUInt32LE(pos+42);
    const nextPos=pos+46+nameLen+extraLen+commentLen;
    if(nextPos>cdEnd||(flags&1)!==0||compSize===0xffffffff||uncompSize===0xffffffff||
       localOffset===0xffffffff||seenOffsets.has(localOffset))
      throw Error('unsupported zip entry');
    seenOffsets.add(localOffset);
    const name=decoder.decode(buffer.subarray(pos+46,pos+46+nameLen));
    pos=nextPos;
    const parts=name.split('/');
    if(name.startsWith('/')||name.includes('\\')||name.includes('\0')||parts.includes('..'))
      throw Error('unsafe archive path');
    if(parts.length<2||!name.endsWith('.json')||(parts[0]!=='traces'&&parts[0]!=='structuredlogs'))
      continue;
    if(uncompSize>MAX_ENTRY_BYTES||compSize>MAX_ARCHIVE_BYTES||uncompSize>MAX_TOTAL_UNCOMPRESSED_BYTES-totalUncompressed)
      throw Error('oversize');
    totalUncompressed+=uncompSize;
    if(localOffset+30>cdOffset||buffer.readUInt32LE(localOffset)!==LOC_SIG)throw Error('corrupt local header');
    const localMethod=buffer.readUInt16LE(localOffset+8);
    const localNameLen=buffer.readUInt16LE(localOffset+26);
    const localExtraLen=buffer.readUInt16LE(localOffset+28);
    const dataStart=localOffset+30+localNameLen+localExtraLen;
    const dataEnd=dataStart+compSize;
    if(localMethod!==method||dataEnd>cdOffset)throw Error('corrupt entry payload');
    const raw=buffer.subarray(dataStart,dataEnd);
    let content;
    if(method===0)content=raw;
    else if(method===8)content=inflateRawSync(raw,{maxOutputLength:MAX_ENTRY_BYTES});
    else throw Error('unsupported compression');
    if(content.length!==uncompSize||(crc32(content)>>>0)!==expectedCrc)throw Error('entry integrity mismatch');
    entries.push({kind:parts[0],document:JSON.parse(decoder.decode(content))});
  }
  if(pos!==cdEnd)throw Error('corrupt central directory');
  return entries;
}

function collectExportIds(document,kind,target){
  const key=kind==='traces'?'resourceSpans':'resourceLogs';
  const groups=Array.isArray(document?.[key])?document[key]:document?.data?.[key];
  if(!Array.isArray(groups))throw Error('malformed export payload');
  for(const group of groups){
    const attrs=group?.resource?.attributes;
    if(attrs===undefined)continue;
    if(!Array.isArray(attrs))throw Error('malformed resource attributes');
    if(!attrs.some(a=>a!==null&&typeof a==='object'&&a.key==='service.name'&&isExactStringValue(a.value,'softwarefactory-shadow')))
      continue;
    const scopes=group[kind==='traces'?'scopeSpans':'scopeLogs'];
    if(!Array.isArray(scopes))throw Error('malformed export scopes');
    for(const scope of scopes){
      if(scope?.scope?.name!=='softwarefactory')continue;
      const rows=scope[kind==='traces'?'spans':'logRecords'];
      if(!Array.isArray(rows))throw Error('malformed export rows');
      for(const row of rows){
        if(kind==='traces'&&row?.name!=='factory.evaluate')continue;
        if(kind==='structuredlogs'&&!isExactStringValue(row?.body,'factory.stage.completed'))continue;
        const trace=row.traceId,span=row.spanId;
        if(typeof trace==='string'&&typeof span==='string'&&
           /^[0-9a-fA-F]{32}$/.test(trace)&&/^[0-9a-fA-F]{16}$/.test(span)&&
           !/^0+$/.test(trace)&&!/^0+$/.test(span)){
          target.add(`${trace.toLowerCase()}:${span.toLowerCase()}`);
        }
      }
    }
  }
}

export function verifyDashboardExport(archivePath){
  const buffer=readBoundedFile(archivePath,MAX_ARCHIVE_BYTES);
  const spans=new Set(),logs=new Set();
  for(const {kind,document} of readDashboardZipJsonEntries(buffer)){
    collectExportIds(document,kind,kind==='traces'?spans:logs);
  }
  if(![...spans].some(id=>logs.has(id)))throw Error('correlated telemetry missing');
  return true;
}

export function runCli(args,{verify=verifyDashboardExport,write=console.log,fail=console.error}={}){
  try{
    if(args.length!==1)throw Error('expected archive');
    verify(args[0]);
    write('Dashboard stored synthetic trace and correlated structured log');
    return 0;
  }catch{
    fail('Dashboard trace/log readback failed');
    return 1;
  }
}

export function runCliIfDirect(entrypoint,moduleUrl,args,setExitCode=value=>{process.exitCode=value;}){
  if(entrypoint&&pathToFileURL(entrypoint).href===moduleUrl){
    setExitCode(runCli(args));
    return true;
  }
  return false;
}

runCliIfDirect(process.argv[1],import.meta.url,process.argv.slice(2));
