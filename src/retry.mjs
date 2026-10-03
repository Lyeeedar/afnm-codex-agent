import {setTimeout as delay} from 'node:timers/promises';
export function isRateLimit(error) {
  if(/insufficient_quota|billing|credit balance/i.test(error.code ?? '') || /insufficient quota|credit balance/i.test(error.message ?? '')) return false;
  return error.status===429 || /rate_limit|rate-limit/.test(error.code ?? '') || /rate limit|too many requests|requests per minute|tokens per minute/i.test(error.message ?? '');
}
export function retryAfterMilliseconds(headers,now=Date.now()) {
  const value=headers.get('retry-after');
  if(value!==null){const seconds=Number(value);if(Number.isFinite(seconds))return Math.max(0,seconds*1000);const date=Date.parse(value);if(Number.isFinite(date))return Math.max(0,date-now);}
  const reset=Number(headers.get('x-ratelimit-reset'));
  return reset>0 ? Math.max(0,reset*1000-now) : undefined;
}
export async function withRateLimitRetries(operation,{maxRetries=6,baseDelayMs=30000,maxDelayMs=600000,sleep=delay,random=Math.random,report=async()=>{},signal}={}) {
  for(let attempt=0;;attempt++) {
    signal?.throwIfAborted();
    try{return await operation(attempt);}
    catch(error){
      if(signal?.aborted || !isRateLimit(error) || attempt>=maxRetries)throw error;
      const backoff=Math.min(maxDelayMs,baseDelayMs*2**attempt);
      const wait=Math.max(backoff,error.retryAfterMs ?? 0)+Math.floor(random()*backoff*0.25);
      await report(`Rate limited. Automatic retry ${attempt+1}/${maxRetries} in ${Math.ceil(wait/1000)} seconds; preserving this session and checkout…`);
      signal?.throwIfAborted();
      await sleep(wait,undefined,{signal});
    }
  }
}
