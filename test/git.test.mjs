import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchForRebase} from '../src/git.mjs';
test('recent branches fetch bounded history without deepening', async()=>{
  const calls=[];
  await fetchForRebase(async(...args)=>calls.push(args),async()=> 'sha','codex/issue-1','main',async()=>{});
  assert.equal(calls.length,1);assert.ok(calls[0].includes('--depth=1'));assert.ok(calls[0].includes('--filter=blob:none'));
});
test('distant branches deepen until a common ancestor is found', async()=>{
  const calls=[];let checks=0;
  const git=async(command)=>{if(command==='merge-base' && checks++===0)throw new Error('no merge base');return command==='rev-parse'?'true':'sha';};
  await fetchForRebase(async(...args)=>calls.push(args),git,'codex/issue-1','main',async()=>{});
  assert.equal(calls.length,2);assert.ok(calls[1].includes('--deepen=2'));assert.ok(calls[1].includes('--filter=blob:none'));assert.ok(!calls.flat().includes('--unshallow'));
});
test('unrelated histories fail instead of retrying or rebasing root', async()=>{
  const git=async(command)=>{if(command==='merge-base')throw new Error('unrelated');return 'false';};
  await assert.rejects(fetchForRebase(async()=>{},git,'branch','main',async()=>{}),/no shared git history/);
});
