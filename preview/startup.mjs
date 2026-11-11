export function startupTimeout(env=process.env) {
  const timeout=Number(env.PREVIEW_READY_TIMEOUT_MS ?? 240000);
  if(!Number.isFinite(timeout) || timeout<=0)throw new Error('PREVIEW_READY_TIMEOUT_MS must be a positive number');
  return timeout;
}

// Capture the process's actual failure before its closed socket causes a retry
// storm. Intentional shutdowns do not replace the original error.
export function monitorPreviewProcess(child,onFailure) {
  let stopping=false;
  let stderr='';
  child.stderr?.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-8192);});
  const exited=(code,signal)=>{
    if(!stopping)onFailure({code,signal,stderr,message:`Vite exited unexpectedly (${signal ? 'signal '+signal : 'code '+code})`});
  };
  const failed=error=>{if(!stopping)onFailure({message:'Vite failed to start: '+error.message});};
  child.once('exit',exited);child.once('error',failed);
  return ()=>{stopping=true;};
}
