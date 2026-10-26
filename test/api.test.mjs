import test from 'node:test';
import assert from 'node:assert/strict';
import {API} from '../src/api.mjs';
test('pagination retains all comments and query parameters',async()=>{
  const paths=[];
  const api=new API('https://api.example','secret',{},async(url)=>{paths.push(url);return Response.json(paths.length===1 ? Array.from({length:100},(_,i)=>i) : [100]);});
  const list=await api.list('/comments?state=all');
  assert.equal(list.length,101);assert.match(paths[1],/state=all&per_page=100&page=2/);
});
test('failed writes are not automatically replayed or leaked',async()=>{
  let calls=0;
  const api=new API('https://api.example','secret',{},async()=>{calls++;return new Response('secret sensitive body',{status:500});});
  await assert.rejects(api.json('/pulls',{method:'POST',body:{}}),/failed \(500\)/);
  assert.equal(calls,1);
});

test('explicitly retry-safe writes have bounded backoff and honor Retry-After',async()=>{
  const waits=[];let calls=0;
  const api=new API('https://api.example','secret',{},async()=>{calls++;return new Response('sensitive body',{status:503,headers:{'Retry-After':'2'}});},{sleep:async ms=>waits.push(ms),random:()=>0});
  await assert.rejects(api.json('/git/blobs',{method:'POST',retrySafe:true,body:{}}),/^Error: API POST \/git\/blobs failed \(503\)$/);
  assert.equal(calls,7);assert.deepEqual(waits,[2000,2000,4000,8000,16000,32000]);
});

test('retry-safe writes do not retry permission or validation failures',async()=>{
  for(const status of [401,403,404,422]) {
    let calls=0;
    const api=new API('https://api.example','secret',{},async()=>{calls++;return new Response('',{status});},{sleep:async()=>assert.fail('unexpected retry')});
    await assert.rejects(api.json('/git/blobs',{method:'POST',retrySafe:true}),error=>error.status===status);
    assert.equal(calls,1);
  }
});

test('successful event writes may have empty response bodies',async()=>{
  const api=new API('https://api.example','secret',{},async()=>new Response('',{status:200}));
  assert.equal(await api.json('/events',{method:'POST',body:{events:[]}}),null);
});
test('truncated successful reads are retried without exposing response contents',async()=>{
  let calls=0;
  const api=new API('https://api.example','secret',{},async()=>++calls===1 ? new Response('') : Response.json({id:'session'}));
  assert.deepEqual(await api.json('/session'),{id:'session'});
  assert.equal(calls,2);
});
