import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyDashboardMetrics,readMetricDocument} from './verify-dashboard-metrics.mjs';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const attributes=values=>Object.entries(values).map(([key,stringValue])=>({key,value:{stringValue}}));
function fixture(){
  const labels=attributes({stage:'evaluate',outcome:'blocked',reason:'POLICY'});
  return {resourceMetrics:[{resource:{attributes:attributes({'service.name':'softwarefactory-shadow'})},scopeMetrics:[{scope:{name:'softwarefactory'},metrics:[
    {name:'factory.stage.count',sum:{isMonotonic:true,aggregationTemporality:2,dataPoints:[{attributes:labels,asDouble:1,startTimeUnixNano:'100',timeUnixNano:'200'}]}},
    {name:'factory.stage.duration',unit:'ms',histogram:{aggregationTemporality:2,dataPoints:[{attributes:labels,count:'1',sum:2.5,startTimeUnixNano:'100',timeUnixNano:'200'}]}}
  ]}]}]};
}
const metrics=doc=>doc.resourceMetrics[0].scopeMetrics[0].metrics;
test('recognizes both instruments in the expected synthetic service and scope',()=>{
  assert.equal(verifyDashboardMetrics([fixture()]),true);
  const a=fixture(),b=fixture();
  metrics(a).pop();metrics(b).shift();
  assert.equal(verifyDashboardMetrics([a,b]),true);
  const c=fixture();const point=metrics(c)[0].sum.dataPoints[0];
  delete point.asDouble;point.asInt='1';
  assert.equal(verifyDashboardMetrics([c]),true);
});
test('fails closed for missing signal, wrong service, scope, labels or invalid values',()=>{
  const mutations=[
    d=>metrics(d).pop(),
    d=>metrics(d).shift(),
    d=>{d.resourceMetrics[0].resource.attributes=attributes({'service.name':'other'});},
    d=>{d.resourceMetrics[0].scopeMetrics[0].scope.name='other';},
    d=>{metrics(d)[0].sum.dataPoints[0].attributes=attributes({stage:'evaluate',outcome:'eligible',reason:'POLICY'});},
    d=>{metrics(d)[0].sum.dataPoints[0].asDouble=0;},
    d=>{metrics(d)[0].sum.dataPoints[0].asDouble=2;},
    d=>{metrics(d)[0].sum.isMonotonic=false;},
    d=>{metrics(d)[1].histogram.dataPoints[0].count='0';},
    d=>{metrics(d)[1].histogram.dataPoints[0].sum=-1;},
    d=>{metrics(d)[1].unit='s';}
  ];
  for(const mutate of mutations){const doc=fixture();mutate(doc);assert.throws(()=>verifyDashboardMetrics([doc]),/DASHBOARD_METRICS_MISSING/);}
  assert.throws(()=>verifyDashboardMetrics([]),/DASHBOARD_METRICS_MISSING/);
});

test('reads a bounded regular file through one open handle; rejects invalid and oversized input',()=>{
  const dir=mkdtempSync(join(tmpdir(),'factory-metrics-'));
  try{
    const path=join(dir,'metrics.json');
    writeFileSync(path,JSON.stringify(fixture()));
    assert.equal(verifyDashboardMetrics([readMetricDocument(path)]),true);
    writeFileSync(path,'{');
    assert.throws(()=>readMetricDocument(path),SyntaxError);
    writeFileSync(path,Buffer.alloc(4_000_001));
    assert.throws(()=>readMetricDocument(path),/INVALID_INPUT/);
    assert.throws(()=>readMetricDocument(dir));
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('rejects contradictory cumulative samples even after a valid sample or across documents',()=>{
  for(const index of [0,1]){
    const points=d=>index===0?metrics(d)[0].sum.dataPoints:metrics(d)[1].histogram.dataPoints;
    const invalid=fixture();
    if(index===0)points(invalid)[0].asDouble=2;
    else points(invalid)[0].count='2';
    const mixed=fixture();
    points(mixed).push(points(invalid)[0]);
    assert.throws(()=>verifyDashboardMetrics([mixed]),/DASHBOARD_METRICS_MISSING/);
    points(mixed).reverse();
    assert.throws(()=>verifyDashboardMetrics([mixed]),/DASHBOARD_METRICS_MISSING/);
    assert.throws(()=>verifyDashboardMetrics([fixture(),invalid]),/DASHBOARD_METRICS_MISSING/);
    assert.throws(()=>verifyDashboardMetrics([invalid,fixture()]),/DASHBOARD_METRICS_MISSING/);
  }
});

const instrument=(doc,index)=>index===0?metrics(doc)[0].sum:metrics(doc)[1].histogram;
test('requires explicit cumulative aggregation for each instrument, including mixed delta intervals',()=>{
  for(const index of [0,1]){
    const named=fixture();
    instrument(named,index).aggregationTemporality='AGGREGATION_TEMPORALITY_CUMULATIVE';
    assert.equal(verifyDashboardMetrics([named]),true);
    for(const value of [undefined,0,1,'AGGREGATION_TEMPORALITY_UNSPECIFIED','AGGREGATION_TEMPORALITY_DELTA','2',null,3]){
      const bad=fixture();
      if(value===undefined)delete instrument(bad,index).aggregationTemporality;
      else instrument(bad,index).aggregationTemporality=value;
      assert.throws(()=>verifyDashboardMetrics([bad]),/DASHBOARD_METRICS_MISSING/);
      assert.throws(()=>verifyDashboardMetrics([fixture(),bad]),/DASHBOARD_METRICS_MISSING/);
      assert.throws(()=>verifyDashboardMetrics([bad,fixture()]),/DASHBOARD_METRICS_MISSING/);
    }
    const delta=fixture();
    const series=instrument(delta,index);
    series.aggregationTemporality=1;
    const first=series.dataPoints[0];
    first.startTimeUnixNano='1';first.timeUnixNano='2';
    series.dataPoints.push({...first,startTimeUnixNano:'2',timeUnixNano:'3'});
    assert.throws(()=>verifyDashboardMetrics([delta]),/DASHBOARD_METRICS_MISSING/);
  }
});
test('ignores missing-data points and never counts them as instrument receipt',()=>{
  for(const index of [0,1]){
    const flagged=fixture();
    const points=instrument(flagged,index).dataPoints;
    points[0].flags=1;
    assert.throws(()=>verifyDashboardMetrics([flagged]),/DASHBOARD_METRICS_MISSING/);
    points[0].flags=3;
    assert.throws(()=>verifyDashboardMetrics([flagged]),/DASHBOARD_METRICS_MISSING/);
    // A flagged placeholder is neither positive evidence nor a contradiction.
    if(index===0)points[0].asDouble=2;
    else points[0].count='2';
    assert.equal(verifyDashboardMetrics([flagged,fixture()]),true);
    assert.equal(verifyDashboardMetrics([fixture(),flagged]),true);
    const mixed=fixture();
    instrument(mixed,index).dataPoints.push(points[0]);
    assert.equal(verifyDashboardMetrics([mixed]),true);
    const zero=fixture();
    instrument(zero,index).dataPoints[0].flags=0;
    assert.equal(verifyDashboardMetrics([zero]),true);
    for(const flags of [-1,1.5,0x100000000,'1',null]){
      const bad=fixture();instrument(bad,index).dataPoints[0].flags=flags;
      assert.throws(()=>verifyDashboardMetrics([bad]),/DASHBOARD_METRICS_MISSING/);
    }
  }
});

test('rejects multiple cumulative recording periods and invalid timestamps',()=>{
  for(const index of [0,1]){
    const reset=fixture();
    const point=instrument(reset,index).dataPoints[0];
    point.startTimeUnixNano='201';point.timeUnixNano='300';
    for(const docs of [[fixture(),reset],[reset,fixture()]])assert.throws(()=>verifyDashboardMetrics(docs),/DASHBOARD_METRICS_MISSING/);
    const mixed=fixture();instrument(mixed,index).dataPoints.push(point);
    assert.throws(()=>verifyDashboardMetrics([mixed]),/DASHBOARD_METRICS_MISSING/);
    const repeated=fixture();instrument(repeated,index).dataPoints[0].timeUnixNano='300';
    assert.equal(verifyDashboardMetrics([fixture(),repeated]),true);
    for(const start of [undefined,'0','-1','18446744073709551616',1.5,'300']){
      const bad=fixture();instrument(bad,index).dataPoints[0].startTimeUnixNano=start;
      assert.throws(()=>verifyDashboardMetrics([bad]),/DASHBOARD_METRICS_MISSING/);
    }
  }
});
test('rejects unexpected recorded labels and conflicting or nonnumeric counter fields',()=>{
  for(const index of [0,1]){
    const extra=fixture();
    instrument(extra,index).dataPoints[0].attributes=attributes({stage:'evaluate',outcome:'blocked',reason:'POLICY',extra:'x'});
    assert.throws(()=>verifyDashboardMetrics([fixture(),extra]),/DASHBOARD_METRICS_MISSING/);
    const wrong=fixture();
    instrument(wrong,index).dataPoints[0].attributes=attributes({stage:'evaluate',outcome:'eligible',reason:'POLICY'});
    assert.throws(()=>verifyDashboardMetrics([fixture(),wrong]),/DASHBOARD_METRICS_MISSING/);
  }
  for(const value of [{asInt:'1',asDouble:2},{asInt:'1',asDouble:1},{asDouble:'1'},{asDouble:null},{}]){
    const bad=fixture(),point=instrument(bad,0).dataPoints[0];
    delete point.asDouble;Object.assign(point,value);
    assert.throws(()=>verifyDashboardMetrics([bad]),/DASHBOARD_METRICS_MISSING/);
  }
});

test('rejects conflicting OTLP attribute value fields in resource or metric labels',()=>{
  for(const index of [0,1]){
    const bad=fixture();instrument(bad,index).dataPoints[0].attributes[0].value.intValue='42';
    assert.throws(()=>verifyDashboardMetrics([bad]),/DASHBOARD_METRICS_MISSING/);
    assert.throws(()=>verifyDashboardMetrics([fixture(),bad]),/DASHBOARD_METRICS_MISSING/);
  }
  const bad=fixture();bad.resourceMetrics[0].resource.attributes[0].value.intValue='42';
  assert.throws(()=>verifyDashboardMetrics([bad]),/DASHBOARD_METRICS_MISSING/);
});

test('malformed claimed service cannot conceal a reset in either document order',()=>{
  const bad=fixture();bad.resourceMetrics[0].resource.attributes[0].value.intValue='42';
  instrument(bad,0).dataPoints[0].startTimeUnixNano='201';instrument(bad,0).dataPoints[0].timeUnixNano='300';
  for(const docs of [[fixture(),bad],[bad,fixture()]])assert.throws(()=>verifyDashboardMetrics(docs),/DASHBOARD_METRICS_MISSING/);
  const duplicate=fixture();duplicate.resourceMetrics[0].resource.attributes.push({key:'service.name',value:{stringValue:'other'}});
  assert.throws(()=>verifyDashboardMetrics([fixture(),duplicate]),/DASHBOARD_METRICS_MISSING/);
  const changed=fixture();instrument(changed,1).dataPoints[0].sum=8.5;
  assert.throws(()=>verifyDashboardMetrics([fixture(),changed]),/DASHBOARD_METRICS_MISSING/);
});
