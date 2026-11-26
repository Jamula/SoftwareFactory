// Acceptance helper for a private OTLP JSON export from the actual Aspire dashboard.
// An SDK receiver fixture or fabricated JSON cannot establish dashboard provenance.
import {readFileSync,statSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const expectedLabels={stage:'evaluate',outcome:'blocked',reason:'POLICY'};
const service='softwarefactory-shadow';
const hasAttributes=(attributes,expected)=>Array.isArray(attributes)&&Object.entries(expected).every(([key,value])=>{
  const matches=attributes.filter(a=>a?.key===key);
  return matches.length===1&&matches[0].value?.stringValue===value;
});
const positiveInteger=value=>(typeof value==='string'&&/^\d+$/.test(value)||typeof value==='number'&&Number.isSafeInteger(value))&&Number.isSafeInteger(Number(value))&&Number(value)>0;
const nonnegativeNumber=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
export function verifyDashboardMetrics(documents){
  let counter=false,histogram=false;
  for(const document of documents){
    for(const resource of document?.resourceMetrics??[]){
      if(!hasAttributes(resource.resource?.attributes,{'service.name':service}))continue;
      for(const scope of resource.scopeMetrics??[]){
        if(scope.scope?.name!=='softwarefactory')continue;
        for(const metric of scope.metrics??[]){
          if(metric.name==='factory.stage.count'&&metric.sum?.isMonotonic===true){
            counter||=(metric.sum.dataPoints??[]).some(p=>hasAttributes(p.attributes,expectedLabels)&&positiveInteger(p.asInt??p.asDouble)&&Number(p.asInt??p.asDouble)===1);
          }
          if(metric.name==='factory.stage.duration'&&metric.unit==='ms'){
            histogram||=(metric.histogram?.dataPoints??[]).some(p=>hasAttributes(p.attributes,expectedLabels)&&positiveInteger(p.count)&&Number(p.count)===1&&nonnegativeNumber(p.sum));
          }
        }
      }
    }
  }
  if(!counter||!histogram)throw Error('DASHBOARD_METRICS_MISSING');
  return true;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const paths=process.argv.slice(2);
    if(!paths.length||paths.length>32)throw Error('INVALID_INPUT');
    const documents=paths.map(path=>{
      const info=statSync(path);
      if(!info.isFile()||info.size>4_000_000)throw Error('INVALID_INPUT');
      return JSON.parse(readFileSync(path,'utf8'));
    });
    verifyDashboardMetrics(documents);
    console.log('Dashboard metric export contains the synthetic counter and histogram');
  }catch{
    // Never print filenames, raw telemetry or arbitrary parse errors.
    console.error('Dashboard metric readback failed');
    process.exitCode=1;
  }
}
