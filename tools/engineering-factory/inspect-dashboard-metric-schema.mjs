// Read only SQLite schema metadata in one fresh, private synthetic dashboard run.
// Never read application rows, export credentials, or claim metric receipt.
import {pathToFileURL} from 'node:url';
import {bounded,openReadOnlyDashboardDb,resolveIsolatedDashboardDb} from './verify-dashboard-metric-receipt.mjs';

const IDENTIFIER=/^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const COLUMN_KIND=/^[A-Za-z0-9_ (),]{0,64}$/;
const TERMS=['metric','instrument','dimension','histogram','resource','scope','attribute'];

export function inspectSchemaConn(conn){
  const names=bounded(conn,"SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name",[ ],128);
  if(names.length===0)throw Error('unexpected table count');
  const tables={};
  let hasMetricTable=false;
  for(const {name} of names){
    if(typeof name!=='string'||!IDENTIFIER.test(name))throw Error('unexpected identifier');
    const lower=name.toLowerCase();
    if(!TERMS.some(term=>lower.includes(term)))continue;
    const columns=bounded(conn,'SELECT name, type FROM pragma_table_info(?) ORDER BY cid',[name],128);
    if(columns.length===0)throw Error('unexpected columns');
    const clean=[];
    for(const {name:column,type:kind} of columns){
      if(typeof column!=='string'||typeof kind!=='string'||!IDENTIFIER.test(column)||!COLUMN_KIND.test(kind))
        throw Error('unexpected column definition');
      clean.push([column,kind]);
    }
    tables[name]=clean;
    if(lower.includes('metric'))hasMetricTable=true;
  }
  if(!hasMetricTable)throw Error('metric schema not observed');
  return {receiptVerified:false,tables};
}

export function inspect(root){
  const dbPath=resolveIsolatedDashboardDb(root);
  const conn=openReadOnlyDashboardDb(dbPath);
  try{
    return inspectSchemaConn(conn);
  }finally{
    conn.close();
  }
}

export function runCli(args,{inspectRoot=inspect,write=console.log,fail=console.error}={}){
  try{
    if(args.length!==1)throw Error('expected root');
    write('Dashboard metric schema (metadata only): '+JSON.stringify(inspectRoot(args[0])));
    return 0;
  }catch{
    fail('Dashboard metric schema discovery failed');
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
