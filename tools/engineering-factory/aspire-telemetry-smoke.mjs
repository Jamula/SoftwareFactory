import {startLocalSdk,validateLocalOtlpEnvironment} from './local-otel-sdk.mjs';

// Only the explicitly started, synthetic AppHost resource enters this path.
export async function runAspireTelemetry(env,start=startLocalSdk,work=()=>import('./aspire-smoke.mjs'),report=console.log){
  const config=env&&typeof env==='object'
    ?{endpoint:env.OTEL_EXPORTER_OTLP_ENDPOINT,protocol:env.OTEL_EXPORTER_OTLP_PROTOCOL,headers:env.OTEL_EXPORTER_OTLP_HEADERS}
    :null;
  if(!validateLocalOtlpEnvironment(config,env))throw Error('LOCAL_OTLP_CONFIGURATION_REQUIRED');
  const sdk=await (start===startLocalSdk?startLocalSdk(config,undefined,env):start(config));
  if(!sdk)throw Error('LOCAL_OTLP_CONFIGURATION_REQUIRED');
  try {
    await sdk.observe('evaluate',async()=>{
      await work();
      return {outcome:'blocked',reason:'POLICY'};
    });
  } catch(error) {
    try {await sdk.shutdown();} catch {}
    throw error;
  }
  await sdk.shutdown();
  // Distinguish successful cleanup from the earlier workload output.
  report('LOCAL_SDK_SHUTDOWN_COMPLETE');
}
if(import.meta.main)await runAspireTelemetry(process.env);
