import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createPreviewTransfer} from '../preview/transfer.mjs';

test('local module socket resets retry through the complete response body',async()=>{
  let requests=0;const retries=[];
  const server=createServer((request,response)=>{
    requests++;
    if(requests===1){request.socket.destroy();return;}
    if(requests===2){response.writeHead(200,{'content-type':'text/javascript','content-length':'1000'});response.write('partial');setImmediate(()=>response.destroy());return;}
    response.setHeader('content-type','text/javascript');response.end('export default "loaded";');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const url=`http://127.0.0.1:${server.address().port}/src/Game.tsx`;
    const transfer=createPreviewTransfer({wait:async()=>{},onRetry:retry=>retries.push(retry)});
    const result=await transfer(url);
    assert.equal(result.status,200);assert.equal(result.body.toString(),'export default "loaded";');
    assert.equal(requests,3);assert.equal(retries.length,2);assert.ok(retries.every(retry=>retry.url===url));
    assert.equal(result.headers['content-type'],'text/javascript');assert.equal(result.headers['content-length'],undefined);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('persistent connection resets stop after the bounded attempts and report the module URL',async()=>{
  let attempts=0;
  const transfer=createPreviewTransfer({attempts:3,wait:async()=>{},fetcher:async()=>{attempts++;throw new TypeError('fetch failed',{cause:Object.assign(new Error('reset'),{code:'ECONNRESET'})});}});
  await assert.rejects(transfer('http://localhost/src/Game.tsx'),/Game.tsx after 3 attempt\(s\): ECONNRESET/);
  assert.equal(attempts,3);
});

test('Vite compiler errors preserve their status and body without retrying',async()=>{
  let requests=0;
  const transfer=createPreviewTransfer({fetcher:async()=>{requests++;return new Response('Trigger adapter changed',{status:500});}});
  const response=await transfer('http://localhost/src/EventTrigger.tsx');
  assert.equal(response.status,500);assert.equal(response.body.toString(),'Trigger adapter changed');assert.equal(requests,1);
});

test('non-network errors fail immediately and release their slot',async()=>{
  let requests=0;
  const transfer=createPreviewTransfer({concurrency:1,fetcher:async()=>{if(++requests===1)throw new Error('invalid request');return new Response('loaded');}});
  await assert.rejects(transfer('first'),/invalid request/);
  assert.equal((await transfer('second')).body.toString(),'loaded');assert.equal(requests,2);
});

test('a waiting module owns the released slot before a new request can enter',async()=>{
  const releases=[];const calls=[];
  const transfer=createPreviewTransfer({concurrency:1,fetcher:url=>new Promise(resolve=>{calls.push(url);releases.push(()=>resolve(new Response(url)));})});
  const first=transfer('first');const queued=transfer('queued');
  releases.shift()();
  const newcomer=first.then(()=>transfer('newcomer'));
  await first;
  assert.deepEqual(calls,['first','queued']);
  releases.shift()();await queued;
  assert.deepEqual(calls,['first','queued','newcomer']);
  releases.shift()();await newcomer;
});
