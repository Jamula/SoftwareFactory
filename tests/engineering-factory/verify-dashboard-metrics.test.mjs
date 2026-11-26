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
    {name:'factory.stage.count',sum:{isMonotonic:true,dataPoints:[{attributes:labels,asDouble:1}]}},
    {name:'factory.stage.duration',unit:'ms',histogram:{dataPoints:[{attributes:labels,count:'1',sum:2.5}]}}
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
