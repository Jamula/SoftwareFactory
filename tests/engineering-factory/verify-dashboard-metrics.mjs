// Acceptance helper for a private OTLP JSON export from the actual Aspire dashboard.
// An SDK receiver fixture or fabricated JSON cannot establish dashboard provenance.
import {openSync,fstatSync,readSync,closeSync,constants} from 'node:fs';
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
            for(const p of metric.sum.dataPoints??[]){
              if(!hasAttributes(p.attributes,expectedLabels))continue;
              const value=p.asInt??p.asDouble;
              if(!positiveInteger(value)||Number(value)!==1)throw Error('DASHBOARD_METRICS_MISSING');
              counter=true;
            }
          }
          if(metric.name==='factory.stage.duration'&&metric.unit==='ms'){
            for(const p of metric.histogram?.dataPoints??[]){
              if(!hasAttributes(p.attributes,expectedLabels))continue;
              if(!positiveInteger(p.count)||Number(p.count)!==1||!nonnegativeNumber(p.sum))throw Error('DASHBOARD_METRICS_MISSING');
              histogram=true;
            }
          }
        }
      }
    }
  }
  if(!counter||!histogram)throw Error('DASHBOARD_METRICS_MISSING');
  return true;
}

// Open once and use the same handle for metadata and bounded reads. A
// replacement of the pathname after open cannot redirect the read.
export function readMetricDocument(path){
  const fd=openSync(path,constants.O_RDONLY|constants.O_NONBLOCK);
  try{
    const info=fstatSync(fd);
    const limit=4_000_000;
    if(!info.isFile()||info.size>limit)throw Error('INVALID_INPUT');
    const buffer=Buffer.alloc(limit+1);
    let offset=0;
    while(offset<buffer.length){
      const bytes=readSync(fd,buffer,offset,buffer.length-offset,null);
      if(bytes===0)break;
      offset+=bytes;
    }
    if(offset>limit)throw Error('INVALID_INPUT');
    return JSON.parse(buffer.subarray(0,offset).toString('utf8'));
  }finally{
    closeSync(fd);
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const paths=process.argv.slice(2);
    if(!paths.length||paths.length>32)throw Error('INVALID_INPUT');
    const documents=paths.map(readMetricDocument);
    verifyDashboardMetrics(documents);
    console.log('Dashboard metric export contains the synthetic counter and histogram');
  }catch{
    // Never print filenames, raw telemetry or arbitrary parse errors.
    console.error('Dashboard metric readback failed');
    process.exitCode=1;
  }
}
