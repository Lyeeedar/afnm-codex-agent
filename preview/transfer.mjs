import {setTimeout as delay} from 'node:timers/promises';

const retryableCodes=new Set(['ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT']);
function networkCode(error) {
  for(let current=error;current;current=current.cause) {
    if(retryableCodes.has(current.code))return current.code;
  }
  return null;
}

export function createPreviewTransfer({fetcher=fetch,concurrency=16,attempts=4,timeout=120000,wait=delay,onRetry=()=>{}}={}) {
  let active=0;const pending=[];
  return async url=>{
    if(active>=concurrency)await new Promise(resolve=>pending.push(resolve));
    else active++;
    const deadline=Date.now()+timeout;
    try {
      for(let attempt=1;;attempt++) {
        try {
          const response=await fetcher(url,{signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});
          // Buffer inside the retry boundary. A reset can also happen after headers.
          const body=Buffer.from(await response.arrayBuffer());
          const headers=Object.fromEntries([...response.headers].filter(([name])=>!['content-encoding','content-length','transfer-encoding'].includes(name)));
          return {status:response.status,headers,body};
        }catch(error) {
          const code=networkCode(error);
          const backoff=250*2**(attempt-1);
          if(!code || attempt>=attempts || Date.now()+backoff>=deadline)throw new Error(`Preview transfer failed for ${url} after ${attempt} attempt(s): ${code ?? error.message}`,{cause:error});
          onRetry({url,attempt,code});
          await wait(backoff);
        }
      }
    }finally {
      // Hand the reserved slot to a waiter before admitting a new request.
      const next=pending.shift();if(next)next();else active--;
    }
  };
}
