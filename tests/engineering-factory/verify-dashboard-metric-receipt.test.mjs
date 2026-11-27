import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {
  LABELS,
  bounded,
  openReadOnlyDashboardDb,
  resolveIsolatedDashboardDb,
  runCli,
  runCliIfDirect,
  verify,
  verifyRun
} from '../../tools/engineering-factory/verify-dashboard-metric-receipt.mjs';

const SCRIPT=resolve('tools/engineering-factory/verify-dashboard-metric-receipt.mjs');

function seedFixture(conn,{startNano=1_795_735_893_000_000_100n,endNano=1_795_735_893_000_000_200n}={}){
  conn.exec(`
    CREATE TABLE telemetry_metric_instruments(instrument_id INTEGER,instrument_name TEXT,unit TEXT,aggregation_temporality INTEGER,is_monotonic INTEGER,resource_id INTEGER,scope_id INTEGER,instrument_type INTEGER);
    CREATE TABLE telemetry_resources(resource_id INTEGER,resource_name TEXT);
    CREATE TABLE telemetry_scopes(scope_id INTEGER,scope_name TEXT);
    CREATE TABLE telemetry_metric_dimensions(dimension_id INTEGER,instrument_id INTEGER);
    CREATE TABLE telemetry_metric_dimension_attributes(dimension_id INTEGER,ordinal INTEGER,attribute_key TEXT,attribute_value TEXT);
    CREATE TABLE telemetry_metric_points(dimension_id INTEGER,start_time_unix_nano INTEGER,end_time_unix_nano INTEGER,integer_value INTEGER,double_value REAL,histogram_sum REAL,histogram_count INTEGER,flags INTEGER,histogram_aggregation_start_unix_nano INTEGER,point_type INTEGER,histogram_aggregation_id INTEGER,bucket_counts BLOB,explicit_bounds BLOB);
    INSERT INTO telemetry_resources VALUES(1,'softwarefactory-shadow');
    INSERT INTO telemetry_scopes VALUES(1,'softwarefactory');
    INSERT INTO telemetry_metric_instruments VALUES(1,'factory.stage.count','',2,1,1,1,2),(2,'factory.stage.duration','ms',2,NULL,1,1,3);
    INSERT INTO telemetry_metric_dimensions VALUES(1,1),(2,2);
  `);
  const insertPoint=conn.prepare('INSERT INTO telemetry_metric_points VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)');
  insertPoint.run(1,startNano,endNano,1,null,null,null,0,null,2);
  insertPoint.run(2,startNano,endNano,null,null,2.5,1,0,startNano,3);
  const insertAttr=conn.prepare('INSERT INTO telemetry_metric_dimension_attributes VALUES(?,?,?,?)');
  for(const dim of [1,2]){
    let ordinal=0;
    for(const [key,val] of Object.entries(LABELS)){
      insertAttr.run(dim,ordinal++,key,val);
    }
  }
}

test('validates 64-bit nanosecond cumulative snapshots, repeated scrapes, double counters, and flagged placeholders',()=>{
  const conn=new DatabaseSync(':memory:');
  try{
    seedFixture(conn);
    assert.equal(verify(conn),true);
    conn.prepare(`
      INSERT INTO telemetry_metric_points(dimension_id,start_time_unix_nano,end_time_unix_nano,integer_value,double_value,histogram_sum,histogram_count,flags,histogram_aggregation_start_unix_nano,point_type)
      VALUES(1,?,?,1,NULL,NULL,NULL,0,NULL,2)
    `).run(1_795_735_893_000_000_100n,1_795_735_893_000_000_300n);
    // Unrecorded placeholder point (flags bit 0 = 1) on an extra dimension is ignored
    conn.exec('INSERT INTO telemetry_metric_dimensions VALUES(3,1)');
    conn.prepare(`
      INSERT INTO telemetry_metric_points(dimension_id,start_time_unix_nano,end_time_unix_nano,integer_value,double_value,histogram_sum,histogram_count,flags,histogram_aggregation_start_unix_nano,point_type)
      VALUES(3,1,2,99,NULL,NULL,NULL,1,NULL,2)
    `).run();
    // Missing flags (NULL) defaults to 0 and double_value=1 counter representation is accepted
    conn.exec('UPDATE telemetry_metric_points SET integer_value=NULL, double_value=1.0, flags=NULL WHERE dimension_id=1');
    assert.equal(verify(conn),true);
  }finally{
    conn.close();
  }

  // Also accept integer-stored double_value (1n) and integer-stored histogram_sum (0n) on untyped columns
  const untyped=new DatabaseSync(':memory:');
  try{
    seedFixture(untyped,{startNano:100n,endNano:200n});
    untyped.exec('DROP TABLE telemetry_metric_points; CREATE TABLE telemetry_metric_points(dimension_id,start_time_unix_nano,end_time_unix_nano,integer_value,double_value,histogram_sum,histogram_count,flags,histogram_aggregation_start_unix_nano,point_type,histogram_aggregation_id,bucket_counts,explicit_bounds);');
    untyped.exec('INSERT INTO telemetry_metric_points VALUES(1,100,200,NULL,1,NULL,NULL,0,NULL,2,NULL,NULL,NULL),(2,100,200,NULL,NULL,0,1,0,NULL,3,NULL,NULL,NULL)');
    assert.equal(verify(untyped),true);
  }finally{
    untyped.close();
  }
});

test('rejects all missing, wrong, out-of-range, or contradictory SQLite metric evidence',()=>{
  const mutations=[
    'DELETE FROM telemetry_metric_instruments WHERE instrument_id=2',
    'DELETE FROM telemetry_metric_dimensions WHERE instrument_id=1',
    'DELETE FROM telemetry_metric_points WHERE dimension_id=2',
    'UPDATE telemetry_metric_instruments SET instrument_type=3 WHERE instrument_id=1',
    'UPDATE telemetry_metric_instruments SET instrument_type=NULL WHERE instrument_id=2',
    'UPDATE telemetry_metric_instruments SET is_monotonic=0 WHERE instrument_id=1',
    "UPDATE telemetry_metric_instruments SET unit='s' WHERE instrument_id=2",
    'UPDATE telemetry_metric_points SET point_type=2 WHERE dimension_id=2',
    'UPDATE telemetry_metric_points SET point_type=99 WHERE dimension_id=1',
    "UPDATE telemetry_metric_points SET point_type='two' WHERE dimension_id=1",
    'UPDATE telemetry_metric_points SET histogram_aggregation_start_unix_nano=100 WHERE dimension_id=1',
    'UPDATE telemetry_metric_points SET histogram_aggregation_id=1 WHERE dimension_id=1',
    "UPDATE telemetry_metric_points SET bucket_counts=X'01' WHERE dimension_id=1",
    "UPDATE telemetry_metric_points SET explicit_bounds=X'01' WHERE dimension_id=1",
    'UPDATE telemetry_metric_points SET end_time_unix_nano=start_time_unix_nano WHERE dimension_id=1',
    'UPDATE telemetry_metric_points SET end_time_unix_nano=start_time_unix_nano WHERE dimension_id=2',
    'UPDATE telemetry_metric_points SET start_time_unix_nano=0 WHERE dimension_id=1',
    "UPDATE telemetry_metric_points SET start_time_unix_nano='bad-time' WHERE dimension_id=1",
    'UPDATE telemetry_metric_points SET flags=1 WHERE dimension_id=1',
    'UPDATE telemetry_metric_points SET flags=-1 WHERE dimension_id=1',
    'UPDATE telemetry_metric_points SET flags=4294967296 WHERE dimension_id=1',
    "UPDATE telemetry_metric_points SET flags='bad-flag' WHERE dimension_id=1",
    'UPDATE telemetry_metric_instruments SET aggregation_temporality=1 WHERE instrument_id=2',
    'UPDATE telemetry_metric_points SET integer_value=2 WHERE dimension_id=1',
    'UPDATE telemetry_metric_points SET integer_value=NULL, double_value=NULL WHERE dimension_id=1',
    'UPDATE telemetry_metric_points SET double_value=2 WHERE dimension_id=1',
    'UPDATE telemetry_metric_points SET integer_value=NULL, double_value=2.0 WHERE dimension_id=1',
    "UPDATE telemetry_metric_points SET integer_value=NULL, double_value='not-a-float' WHERE dimension_id=1",
    'UPDATE telemetry_metric_points SET histogram_count=2 WHERE dimension_id=2',
    'UPDATE telemetry_metric_points SET integer_value=1 WHERE dimension_id=2',
    'UPDATE telemetry_metric_points SET histogram_sum=-1.0 WHERE dimension_id=2',
    "UPDATE telemetry_metric_points SET histogram_sum='not-a-float' WHERE dimension_id=2",
    'UPDATE telemetry_metric_points SET histogram_aggregation_start_unix_nano=999 WHERE dimension_id=2',
    'INSERT INTO telemetry_metric_points(dimension_id,start_time_unix_nano,end_time_unix_nano,integer_value,double_value,histogram_sum,histogram_count,flags,histogram_aggregation_start_unix_nano,point_type) VALUES(2,100,300,NULL,NULL,8.5,1,0,100,3)',
    "UPDATE telemetry_metric_dimension_attributes SET attribute_value='eligible' WHERE attribute_key='outcome'",
    'DELETE FROM telemetry_metric_dimension_attributes WHERE dimension_id=1 AND ordinal=0',
    "UPDATE telemetry_metric_dimension_attributes SET attribute_key='stage' WHERE dimension_id=1 AND ordinal=1",
    'UPDATE telemetry_metric_dimension_attributes SET attribute_value=123 WHERE dimension_id=1 AND ordinal=0',
    "UPDATE telemetry_resources SET resource_name='wrong'",
    "UPDATE telemetry_scopes SET scope_name='wrong'",
    'INSERT INTO telemetry_metric_points(dimension_id,start_time_unix_nano,end_time_unix_nano,integer_value,double_value,histogram_sum,histogram_count,flags,histogram_aggregation_start_unix_nano,point_type) VALUES(1,201,300,1,NULL,NULL,NULL,0,NULL,2)',
    'INSERT INTO telemetry_metric_points(dimension_id,start_time_unix_nano,end_time_unix_nano,integer_value,double_value,histogram_sum,histogram_count,flags,histogram_aggregation_start_unix_nano,point_type) VALUES(2,201,300,NULL,NULL,2.5,1,0,201,3)'
  ];
  for(const sql of mutations){
    const conn=new DatabaseSync(':memory:');
    try{
      seedFixture(conn,{startNano:100n,endNano:200n});
      conn.exec(sql);
      assert.throws(()=>verify(conn),undefined,`expected failure for: ${sql}`);
    }finally{
      conn.close();
    }
  }

  // Multiple recorded dimensions for the same instrument fail closed
  const multiDim=new DatabaseSync(':memory:');
  try{
    seedFixture(multiDim,{startNano:100n,endNano:200n});
    multiDim.exec('INSERT INTO telemetry_metric_dimensions VALUES(9,1)');
    const ins=multiDim.prepare('INSERT INTO telemetry_metric_dimension_attributes VALUES(9,?,?,?)');
    let ord=0;
    for(const [k,v] of Object.entries(LABELS))ins.run(ord++,k,v);
    multiDim.exec('INSERT INTO telemetry_metric_points(dimension_id,start_time_unix_nano,end_time_unix_nano,integer_value,double_value,histogram_sum,histogram_count,flags,histogram_aggregation_start_unix_nano,point_type) VALUES(9,100,200,1,NULL,NULL,NULL,0,NULL,2)');
    assert.throws(()=>verify(multiDim),/multiple recorded dimensions/);
    assert.throws(()=>bounded(multiDim,'SELECT dimension_id FROM telemetry_metric_dimensions',[],1),/unexpected result size/);
  }finally{
    multiDim.close();
  }
});

test('verifyRun enforces private single-run directory structure, rejects symlinks, and opens SQLite read-only',()=>{
  const dir=mkdtempSync(join(tmpdir(),'factory-receipt-run-'));
  try{
    assert.throws(()=>resolveIsolatedDashboardDb(''),/missing run root/);
    assert.throws(()=>resolveIsolatedDashboardDb(null),/missing run root/);
    assert.throws(()=>verifyRun(dir));

    const runsFile=join(dir,'file-root');
    mkdirSync(runsFile);
    writeFileSync(join(runsFile,'runs'),'not-a-dir');
    assert.throws(()=>verifyRun(runsFile),/missing run root/);

    const runsRoot=join(dir,'valid');
    const runDir=join(runsRoot,'runs','run-1');
    mkdirSync(runDir,{recursive:true});
    writeFileSync(join(runsRoot,'runs','ignore-regular-file.txt'),'ignored');
    assert.throws(()=>verifyRun(runsRoot)); // missing dashboard.db

    mkdirSync(join(runDir,'dashboard.db'));
    assert.throws(()=>verifyRun(runsRoot),/missing database/);
    rmSync(join(runDir,'dashboard.db'),{recursive:true,force:true});

    const dbPath=join(runDir,'dashboard.db');
    const writer=new DatabaseSync(dbPath);
    seedFixture(writer);
    writer.close();

    assert.equal(verifyRun(runsRoot),true);

    const roConn=openReadOnlyDashboardDb(dbPath);
    try{
      assert.equal(roConn.prepare('PRAGMA query_only').get().query_only,1n);
      assert.equal(roConn.prepare('PRAGMA trusted_schema').get().trusted_schema,0n);
      assert.throws(()=>roConn.exec('DELETE FROM telemetry_resources'));
    }finally{
      roConn.close();
    }

    const makeLink=(target,linkPath,dirFallback)=>{
      try{
        symlinkSync(target,linkPath,process.platform==='win32'?'junction':undefined);
      }catch{
        symlinkSync(dirFallback,linkPath,'junction');
      }
    };

    // Symlink child inside runs is rejected
    const linkChild=join(runsRoot,'runs','linked-run');
    makeLink(runDir,linkChild,runDir);
    assert.throws(()=>verifyRun(runsRoot),/unexpected run link/);
    rmSync(linkChild,{recursive:true,force:true});

    // Ambiguous second run directory is rejected
    const run2=join(runsRoot,'runs','run-2');
    mkdirSync(run2);
    assert.throws(()=>verifyRun(runsRoot),/ambiguous run/);
    rmSync(run2,{recursive:true,force:true});

    // >64 entries in runs is rejected
    const crowded=join(dir,'crowded');
    mkdirSync(join(crowded,'runs'),{recursive:true});
    for(let i=0;i<65;i++)writeFileSync(join(crowded,'runs',`f-${i}`),'');
    assert.throws(()=>verifyRun(crowded),/ambiguous run/);

    // Symlinked runs directory is rejected
    const symRoot=join(dir,'sym-root');
    mkdirSync(symRoot);
    makeLink(join(runsRoot,'runs'),join(symRoot,'runs'),join(runsRoot,'runs'));
    assert.throws(()=>verifyRun(symRoot),/missing run root/);

    // Symlinked dashboard.db is rejected (true regular-file symlink)
    const symDbRoot=join(dir,'sym-db');
    mkdirSync(join(symDbRoot,'runs','r1'),{recursive:true});
    symlinkSync(dbPath,join(symDbRoot,'runs','r1','dashboard.db'),'file');
    assert.throws(()=>verifyRun(symDbRoot),/missing database/);

    // CLI direct and subprocess execution
    const out=[],err=[];
    assert.equal(runCli([runsRoot],{write:v=>out.push(v),fail:v=>err.push(v)}),0);
    assert.deepEqual(out,['Dashboard persisted synthetic cumulative counter and histogram: verified']);
    assert.equal(runCli([],{write:v=>out.push(v),fail:v=>err.push(v)}),1);
    assert.deepEqual(err,['Dashboard metric persistence verification failed']);

    let exitCode;
    assert.equal(runCliIfDirect('',import.meta.url,[],v=>{exitCode=v;}),false);
    assert.equal(runCliIfDirect(SCRIPT,pathToFileURL(SCRIPT).href,[runsRoot],v=>{exitCode=v;}),true);
    assert.equal(exitCode,0);

    const proc=spawnSync(process.execPath,[SCRIPT,join(dir,'missing-secret-root')],{encoding:'utf8'});
    assert.equal(proc.status,1);
    assert.equal(proc.stdout,'');
    assert.equal(proc.stderr,'Dashboard metric persistence verification failed\n');
    assert.equal(proc.stderr.includes('missing-secret-root'),false);
  }finally{
    rmSync(dir,{recursive:true,force:true});
  }
});
