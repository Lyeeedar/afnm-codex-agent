import test from 'node:test';
import assert from 'node:assert/strict';
import {withRateLimitRetries,retryAfterMilliseconds} from '../src/retry.mjs';
test('session rate limits back off then resume without retrying ordinary failures',async()=>{
  let calls=0;const waits=[],reports=[];
  const value=await withRateLimitRetries(async attempt=>{calls++;if(attempt<2)throw new Error("You've exceeded the rate limit. Please slow down and try again later.");return 'done';},{sleep:async ms=>waits.push(ms),random:()=>0,report:async message=>reports.push(message)});
  assert.equal(value,'done');assert.equal(calls,3);assert.deepEqual(waits,[30000,60000]);assert.equal(reports.length,2);
  calls=0;await assert.rejects(withRateLimitRetries(async()=>{calls++;throw new Error('permission denied');}),/permission denied/);assert.equal(calls,1);
});
test('retry count is bounded and server backoff is honored',async()=>{
  const waits=[];let calls=0;
  await assert.rejects(withRateLimitRetries(async()=>{calls++;throw Object.assign(new Error('limited'),{status:429,retryAfterMs:90000});},{maxRetries:2,sleep:async ms=>waits.push(ms),random:()=>0}),/limited/);
  assert.equal(calls,3);assert.deepEqual(waits,[90000,90000]);
  assert.equal(retryAfterMilliseconds(new Headers({'retry-after':'120'})),120000);
  assert.equal(retryAfterMilliseconds(new Headers({'retry-after':'Thu, 01 Jan 1970 00:01:00 GMT'}),0),60000);
});
test('stopping a run interrupts backoff without a new submission',async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(withRateLimitRetries(async()=>{calls++;throw new Error('rate limit');},{signal:controller.signal,report:async()=>controller.abort(new Error('stopped'))}),/stopped/);
  assert.equal(calls,1);
});
