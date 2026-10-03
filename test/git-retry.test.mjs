import test from 'node:test';
import assert from 'node:assert/strict';
import {retryGitTransfer} from '../src/git-retry.mjs';
test('interrupted or timed-out Git downloads retry, permissions and conflicts do not',async()=>{
  const waits=[];let calls=0;
  const result=await retryGitTransfer(async()=>{calls++;if(calls===1)throw Object.assign(new Error('killed'),{timedOut:true});if(calls===2)throw new Error('RPC failed; curl 56 Connection reset');return 'downloaded';},async()=>{},{sleep:async ms=>waits.push(ms)});
  assert.equal(result,'downloaded');assert.equal(calls,3);assert.deepEqual(waits,[15000,30000]);
  for(const message of ['Authentication failed','CONFLICT (content): Merge conflict','requested URL returned error: 403']) {
    calls=0;await assert.rejects(retryGitTransfer(async()=>{calls++;throw new Error(message);},async()=>{},{sleep:async()=>{}}));assert.equal(calls,1);
  }
});
test('persistent Git network errors stop after three attempts',async()=>{
  let calls=0;await assert.rejects(retryGitTransfer(async()=>{calls++;throw new Error('fatal: early EOF');},async()=>{},{sleep:async()=>{}}),/early EOF/);assert.equal(calls,3);
});
