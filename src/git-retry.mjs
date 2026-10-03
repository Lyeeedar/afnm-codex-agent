import {setTimeout as delay} from 'node:timers/promises';
export function transientGitFailure(error) {
  return error.timedOut || /early EOF|RPC failed|curl (?:18|28|35|52|55|56|92)|connection (?:reset|timed out)|could not resolve host|remote end hung up|HTTP (?:429|5\d\d)|requested URL returned error: (?:429|5\d\d)|fetch-pack: unexpected disconnect/i.test(error.message);
}
export async function retryGitTransfer(operation,report,{sleep=delay}={}) {
  for(let attempt=0;;attempt++) {
    try {return await operation();}
    catch(error) {
      if(attempt>=2 || !transientGitFailure(error))throw error;
      const wait=15000*2**attempt;
      await report(`Git transfer interrupted${error.timedOut?' (download timeout)':''}. Retrying in ${wait/1000} seconds (${attempt+1}/2)…`);
      await sleep(wait);
    }
  }
}
