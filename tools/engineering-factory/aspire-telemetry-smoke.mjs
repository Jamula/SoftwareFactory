import {startLocalSdk} from './local-otel-sdk.mjs';

// Only the explicitly started, synthetic AppHost resource enters this path.
export async function runAspireTelemetry(env,start=startLocalSdk,work=()=>import('./aspire-smoke.mjs')){
  const sdk=await start({endpoint:env.OTEL_EXPORTER_OTLP_ENDPOINT,protocol:env.OTEL_EXPORTER_OTLP_PROTOCOL,headers:env.OTEL_EXPORTER_OTLP_HEADERS});
  if(!sdk)throw Error('LOCAL_OTLP_CONFIGURATION_REQUIRED');
  try {
    await sdk.observe('evaluate',async()=>{
      await work();
      return {outcome:'blocked',reason:'POLICY'};
    });
  } finally {
    await sdk.shutdown();
  }
}
if(import.meta.main)await runAspireTelemetry(process.env);
