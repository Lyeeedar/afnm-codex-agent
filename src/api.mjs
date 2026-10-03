import {setTimeout as delay} from 'node:timers/promises';
export class API {
  constructor(base, token, headers={}, fetcher=fetch) { this.base=base; this.token=token; this.headers=headers; this.fetcher=fetcher; }
  async request(path, {method='GET',body,headers={},signal}={}) {
    for (let attempt=0;;attempt++) {
      const response=await this.fetcher(this.base+path,{method,headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json',...this.headers,...headers},body:body === undefined ? undefined : JSON.stringify(body),signal:signal ?? AbortSignal.timeout(60000)});
      if (response.ok) return response;
      // Retry safe reads and explicitly idempotent writes only.
      if (attempt<4 && (method==='GET' || headers['Idempotency-Key']) && (response.status===429 || response.status>=500)) {
        await response.body?.cancel(); await delay(Math.min(30000,Number(response.headers.get('retry-after') ?? 2**attempt)*1000)); continue;
      }
      throw new Error(`API ${method} ${path.split('?')[0]} failed (${response.status})`);
    }
  }
  async json(path,options={}) {
    for(let attempt=0;;attempt++) {
      const r=await this.request(path,options);
      if(r.status===204) return null;
      const text=await r.text();
      // Event submission/cancellation may succeed without a response body.
      if(!text.trim() && options.method && options.method!=='GET') return null;
      try { return JSON.parse(text); }
      catch {
        if(attempt<2 && (!options.method || options.method==='GET')) { await delay(1000); continue; }
        throw new Error(`API ${options.method || 'GET'} ${path.split('?')[0]} returned invalid JSON (${r.status})`);
      }
    }
  }
  async list(path) {
    const all=[]; let page=1;
    while(true) { const items=await this.json(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page++}`); all.push(...items); if(items.length<100) return all; }
  }
}
