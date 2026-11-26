// Acceptance helper for a private OTLP JSON export from the actual Aspire dashboard.
// An SDK receiver fixture or fabricated JSON cannot establish dashboard provenance.
import {openSync,fstatSync,readSync,closeSync,constants} from 'node:fs';
import {pathToFileURL} from 'node:url';

const expectedLabels={stage:'evaluate',outcome:'blocked',reason:'POLICY'};
const service='softwarefactory-shadow';
const hasAttributes=(attributes,expected)=>Array.isArray(attributes)&&Object.entries(expected).every(([key,value])=>{
  const matches=attributes.filter(a=>a?.key===key);
  return matches.length===1&&matches[0].value!==null&&typeof matches[0].value==='object'&&!Array.isArray(matches[0].value)&&Object.keys(matches[0].value).length===1&&Object.hasOwn(matches[0].value,'stringValue')&&matches[0].value.stringValue===value;
});
const positiveInteger=value=>(typeof value==='string'&&/^\d+$/.test(value)||typeof value==='number'&&Number.isSafeInteger(value))&&Number.isSafeInteger(Number(value))&&Number(value)>0;
const nonnegativeNumber=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
// OTLP protobuf JSON supports the enum name or its numeric wire value.
const cumulative=value=>value===2||value==='AGGREGATION_TEMPORALITY_CUMULATIVE';
function recorded(point){
  const flags=point.flags===undefined?0:point.flags;
  // A malformed flag is not evidence; uint32 is the OTLP field type.
  if(!Number.isInteger(flags)||flags<0||flags>0xffffffff)throw Error('DASHBOARD_METRICS_MISSING');
  return (flags&1)===0; // DATA_POINT_FLAGS_NO_RECORDED_VALUE_MASK
}
const timestamp=value=>{
  if(typeof value==='number'&&Number.isSafeInteger(value)&&value>0)return BigInt(value);
  if(typeof value==='string'&&/^[0-9]{1,20}$/.test(value)){
    const n=BigInt(value);
    if(n>0n&&n<=18446744073709551615n)return n;
  }
  throw Error('DASHBOARD_METRICS_MISSING');
};
function period(point,prior){
  const start=timestamp(point.startTimeUnixNano);
  const end=timestamp(point.timeUnixNano);
  if(end<start||(prior!==undefined&&prior!==start))throw Error('DASHBOARD_METRICS_MISSING');
  return start;
}
function exactLabels(point){
  if(!hasAttributes(point.attributes,expectedLabels)||point.attributes.length!==Object.keys(expectedLabels).length)
    throw Error('DASHBOARD_METRICS_MISSING');
}
export function verifyDashboardMetrics(documents){
  let counter,histogram,histogramSum;
  for(const document of documents){
    for(const resource of document?.resourceMetrics??[]){
      const attrs=resource.resource?.attributes;
      if(!hasAttributes(attrs,{'service.name':service})){
        if(Array.isArray(attrs)&&attrs.some(a=>a?.key==='service.name'&&a.value?.stringValue===service))
          throw Error('DASHBOARD_METRICS_MISSING');
        continue;
      }
      for(const scope of resource.scopeMetrics??[]){
        if(scope.scope?.name!=='softwarefactory')continue;
        for(const metric of scope.metrics??[]){
          if(metric.name==='factory.stage.count'){
            if(metric.sum?.isMonotonic!==true||!cumulative(metric.sum.aggregationTemporality))throw Error('DASHBOARD_METRICS_MISSING');
            for(const p of metric.sum.dataPoints??[]){
              if(!recorded(p))continue;
              exactLabels(p);
              const int=Object.hasOwn(p,'asInt'),double=Object.hasOwn(p,'asDouble');
              if(int===double||(int?(!positiveInteger(p.asInt)||Number(p.asInt)!==1):p.asDouble!==1))
                throw Error('DASHBOARD_METRICS_MISSING');
              counter=period(p,counter);
            }
          }
          if(metric.name==='factory.stage.duration'){
            if(metric.unit!=='ms'||!cumulative(metric.histogram?.aggregationTemporality))throw Error('DASHBOARD_METRICS_MISSING');
            for(const p of metric.histogram.dataPoints??[]){
              if(!recorded(p))continue;
              exactLabels(p);
              if(!positiveInteger(p.count)||Number(p.count)!==1||!nonnegativeNumber(p.sum))throw Error('DASHBOARD_METRICS_MISSING');
              if(histogramSum!==undefined&&p.sum!==histogramSum)throw Error('DASHBOARD_METRICS_MISSING');
              histogramSum=p.sum;
              histogram=period(p,histogram);
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
