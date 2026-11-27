// Verify only fixed synthetic metrics in the Aspire 17 dashboard database.
// Read a fresh, private Run-mode database after authenticated runtime and clean stop.
// No raw rows, arbitrary SQL, credentials, or database artifacts leave the runner.
import {lstatSync,readdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';

export const NAMES=Object.freeze(['factory.stage.count','factory.stage.duration']);
export const TYPE_CODES=new Map([[NAMES[0],2n],[NAMES[1],3n]]);
export const LABELS=Object.freeze({stage:'evaluate',outcome:'blocked',reason:'POLICY'});
const LABEL_KEYS=Object.keys(LABELS);

export function bounded(conn,sql,args=[],limit=128){
  const stmt=conn.prepare(sql);
  stmt.setReadBigInts(true);
  const rows=[];
  for(const row of stmt.iterate(...args)){
    if(rows.length===limit)throw Error('unexpected result size');
    rows.push(row);
  }
  return rows;
}

function validLabels(attrs){
  if(attrs.length!==LABEL_KEYS.length)return false;
  const seen=new Set();
  for(const attr of attrs){
    const key=attr.attribute_key,val=attr.attribute_value;
    if(typeof key!=='string'||typeof val!=='string'||!Object.hasOwn(LABELS,key)||LABELS[key]!==val||seen.has(key))
      return false;
    seen.add(key);
  }
  return true;
}

function validDoubleOne(value){
  return (typeof value==='number'&&value===1)||(typeof value==='bigint'&&value===1n);
}

function parseHistogramSum(value){
  if(typeof value==='number'&&Number.isFinite(value)&&value>=0)return value;
  if(typeof value==='bigint'&&value>=0n&&value<=BigInt(Number.MAX_SAFE_INTEGER))return Number(value);
  throw Error('histogram sum');
}

export function verify(conn){
  const instruments=bounded(conn,`
    SELECT i.instrument_id, i.instrument_name, i.unit, i.aggregation_temporality,
           i.is_monotonic, r.resource_name, s.scope_name, i.instrument_type
    FROM telemetry_metric_instruments i
    LEFT JOIN telemetry_resources r ON r.resource_id=i.resource_id
    LEFT JOIN telemetry_scopes s ON s.scope_id=i.scope_id
    WHERE i.instrument_name IN (?, ?)
  `,NAMES);
  if(instruments.length!==2||!instruments.some(r=>r.instrument_name===NAMES[0])||!instruments.some(r=>r.instrument_name===NAMES[1]))
    throw Error('instrument identity');
  for(const inst of instruments){
    const name=inst.instrument_name;
    if(inst.resource_name!=='softwarefactory-shadow'||inst.scope_name!=='softwarefactory'||inst.aggregation_temporality!==2n)
      throw Error('instrument provenance or temporality');
    if(typeof inst.instrument_type!=='bigint'||inst.instrument_type!==TYPE_CODES.get(name))
      throw Error('instrument type');
    const counter=name===NAMES[0];
    if((counter&&inst.is_monotonic!==1n)||(!counter&&inst.unit!=='ms'))
      throw Error('instrument kind');
    const dimensions=bounded(conn,'SELECT dimension_id FROM telemetry_metric_dimensions WHERE instrument_id=?',[inst.instrument_id]);
    if(dimensions.length===0)throw Error('missing dimension');
    let period=null;
    let histogramSum=null;
    let recordedDimension=null;
    for(const {dimension_id:dimensionId} of dimensions){
      const attrs=bounded(conn,`
        SELECT attribute_key, attribute_value FROM telemetry_metric_dimension_attributes
        WHERE dimension_id=? ORDER BY ordinal
      `,[dimensionId]);
      const points=bounded(conn,`
        SELECT start_time_unix_nano, end_time_unix_nano, integer_value, double_value,
               histogram_sum, histogram_count, flags, histogram_aggregation_start_unix_nano, point_type,
               histogram_aggregation_id, bucket_counts, explicit_bounds
        FROM telemetry_metric_points WHERE dimension_id=?
      `,[dimensionId],1024);
      for(const p of points){
        if(p.flags!==null&&(typeof p.flags!=='bigint'||p.flags<0n||p.flags>0xffffffffn))
          throw Error('invalid flags');
        if(p.flags!==null&&(p.flags&1n)!==0n)continue;
        if(typeof p.point_type!=='bigint'||p.point_type!==TYPE_CODES.get(name))
          throw Error('point type');
        if(!validLabels(attrs))throw Error('unexpected recorded labels');
        if(recordedDimension!==null&&recordedDimension!==dimensionId)
          throw Error('multiple recorded dimensions');
        recordedDimension=dimensionId;
        if(typeof p.start_time_unix_nano!=='bigint'||typeof p.end_time_unix_nano!=='bigint'||
           p.start_time_unix_nano<=0n||p.start_time_unix_nano>=p.end_time_unix_nano)
          throw Error('invalid timestamps');
        if(period!==null&&period!==p.start_time_unix_nano)
          throw Error('multiple cumulative periods');
        period=p.start_time_unix_nano;
        if(counter){
          if((p.integer_value===null)===(p.double_value===null))
            throw Error('counter value fields');
          if((p.integer_value!==null&&p.integer_value!==1n)||(p.double_value!==null&&!validDoubleOne(p.double_value)))
            throw Error('counter value');
          if(p.histogram_sum!==null||p.histogram_count!==null||p.histogram_aggregation_start_unix_nano!==null||
             p.histogram_aggregation_id!==null||p.bucket_counts!==null||p.explicit_bounds!==null)
            throw Error('conflicting histogram fields');
        }else{
          if(p.integer_value!==null||p.double_value!==null||p.histogram_count!==1n)
            throw Error('histogram count');
          const total=parseHistogramSum(p.histogram_sum);
          if(histogramSum!==null&&total!==histogramSum)
            throw Error('contradictory histogram sum');
          histogramSum=total;
          if(p.histogram_aggregation_start_unix_nano!==null&&p.histogram_aggregation_start_unix_nano!==p.start_time_unix_nano)
            throw Error('histogram aggregation period');
        }
      }
    }
    if(period===null)throw Error('missing recorded points');
  }
  return true;
}

export function resolveIsolatedDashboardDb(root){
  if(typeof root!=='string'||root.length===0)throw Error('missing run root');
  const resolvedRoot=realpathSync(root);
  const runs=join(resolvedRoot,'runs');
  const runsStat=lstatSync(runs);
  if(runsStat.isSymbolicLink()||!runsStat.isDirectory())throw Error('missing run root');
  const names=readdirSync(runs);
  if(names.length>64)throw Error('ambiguous run');
  const directories=[];
  for(const name of names){
    const childPath=join(runs,name);
    const childStat=lstatSync(childPath);
    if(childStat.isSymbolicLink())throw Error('unexpected run link');
    if(childStat.isDirectory())directories.push(childPath);
  }
  if(directories.length!==1)throw Error('ambiguous run');
  const dbPath=join(directories[0],'dashboard.db');
  const dbStat=lstatSync(dbPath);
  if(dbStat.isSymbolicLink()||!dbStat.isFile())throw Error('missing database');
  return dbPath;
}

export function openReadOnlyDashboardDb(dbPath){
  const conn=new DatabaseSync(`${pathToFileURL(dbPath).href}?mode=ro`,{
    readOnly:true,
    timeout:2000,
    readBigInts:true,
    allowExtension:false,
    defensive:true
  });
  conn.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
  return conn;
}

export function verifyRun(root){
  const dbPath=resolveIsolatedDashboardDb(root);
  const conn=openReadOnlyDashboardDb(dbPath);
  try{
    return verify(conn);
  }finally{
    conn.close();
  }
}

export function runCli(args,{verifyRoot=verifyRun,write=console.log,fail=console.error}={}){
  try{
    if(args.length!==1)throw Error('expected root');
    verifyRoot(args[0]);
    write('Dashboard persisted synthetic cumulative counter and histogram: verified');
    return 0;
  }catch{
    fail('Dashboard metric persistence verification failed');
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
