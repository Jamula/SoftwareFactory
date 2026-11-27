import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {
  inspect,
  inspectSchemaConn,
  runCli,
  runCliIfDirect
} from '../../tools/engineering-factory/inspect-dashboard-metric-schema.mjs';

const SCRIPT=resolve('tools/engineering-factory/inspect-dashboard-metric-schema.mjs');

test('reads metric schema metadata without row payloads and rejects ambiguous or missing runs',()=>{
  const dir=mkdtempSync(join(tmpdir(),'factory-schema-'));
  try{
    assert.throws(()=>inspect(dir));
    const run1=join(dir,'runs','run-1');
    mkdirSync(run1,{recursive:true});
    const dbPath=join(run1,'dashboard.db');
    const conn=new DatabaseSync(dbPath);
    conn.exec(`
      CREATE TABLE MetricPoints (Id INTEGER, Payload VARCHAR(64));
      INSERT INTO MetricPoints VALUES (1, 'private-fixture-value');
      CREATE TABLE Logs (Body TEXT);
    `);
    conn.close();

    const result=inspect(dir);
    assert.equal(result.receiptVerified,false);
    assert.deepEqual(result.tables,{MetricPoints:[['Id','INTEGER'],['Payload','VARCHAR(64)']]});
    assert.equal(JSON.stringify(result).includes('private-fixture-value'),false);

    const out=[],err=[];
    assert.equal(runCli([dir],{write:v=>out.push(v),fail:v=>err.push(v)}),0);
    assert.deepEqual(out,[
      'Dashboard metric schema (metadata only): {"receiptVerified":false,"tables":{"MetricPoints":[["Id","INTEGER"],["Payload","VARCHAR(64)"]]}}'
    ]);
    assert.deepEqual(err,[]);

    let exitCode;
    assert.equal(runCliIfDirect('',import.meta.url,[],v=>{exitCode=v;}),false);
    assert.equal(runCliIfDirect(SCRIPT,pathToFileURL(SCRIPT).href,[dir],v=>{exitCode=v;}),true);
    assert.equal(exitCode,0);

    mkdirSync(join(dir,'runs','run-2'));
    assert.throws(()=>inspect(dir),/ambiguous run/);
  }finally{
    rmSync(dir,{recursive:true,force:true});
  }
});

test('fails closed on empty schema, missing metric table, unsafe identifiers, unsafe column types, and bad CLI args',()=>{
  const empty=new DatabaseSync(':memory:');
  try{
    assert.throws(()=>inspectSchemaConn(empty),/unexpected table count/);
    empty.exec('CREATE TABLE Logs (Body TEXT); CREATE TABLE telemetry_resources (resource_id INTEGER);');
    assert.throws(()=>inspectSchemaConn(empty),/metric schema not observed/);
  }finally{
    empty.close();
  }

  const badTable=new DatabaseSync(':memory:');
  try{
    badTable.exec('CREATE TABLE "metric-unsafe" (id INTEGER)');
    assert.throws(()=>inspectSchemaConn(badTable),/unexpected identifier/);
  }finally{
    badTable.close();
  }

  const badCol=new DatabaseSync(':memory:');
  try{
    badCol.exec('CREATE TABLE metric_points ("bad-col" INTEGER)');
    assert.throws(()=>inspectSchemaConn(badCol),/unexpected column definition/);
  }finally{
    badCol.close();
  }

  const badType=new DatabaseSync(':memory:');
  try{
    badType.exec('CREATE TABLE metric_points (id "INT;DROP")');
    assert.throws(()=>inspectSchemaConn(badType),/unexpected column definition/);
  }finally{
    badType.close();
  }

  const fakeEmptyCols={
    prepare:sql=>({
      setReadBigInts(){},
      *iterate(){
        if(sql.includes('sqlite_schema'))yield {name:'metric_points'};
      }
    })
  };
  assert.throws(()=>inspectSchemaConn(fakeEmptyCols),/unexpected columns/);

  const err=[];
  assert.equal(runCli([],{fail:v=>err.push(v)}),1);
  assert.deepEqual(err,['Dashboard metric schema discovery failed']);

  const proc=spawnSync(process.execPath,[SCRIPT,'/nonexistent-private-path'],{encoding:'utf8'});
  assert.equal(proc.status,1);
  assert.equal(proc.stdout,'');
  assert.equal(proc.stderr,'Dashboard metric schema discovery failed\n');
  assert.equal(proc.stderr.includes('nonexistent-private-path'),false);
});
