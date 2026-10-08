import test from 'node:test';
import assert from 'node:assert/strict';
import {Progress} from '../src/core.mjs';
import {followSessionTurn} from '../src/session-stream.mjs';

const root=(status,id='current',error)=>({id,status,subagent_id:null,error});
const outcome=(status='completed',id='current')=>({type:`agent.session.turn.${status}`,turn:root(status,id)});
const message=(text,id='msg',status='completed',turn_id='current')=>({id,type:'message',role:'assistant',turn_id,status,content:[{type:'output_text',text}]});
const textEvent=(type,text,id='msg')=>({type:`agent.session.turn.output_text.${type}`,item_id:id,output_index:0,content_index:0,...(type==='delta'?{delta:text}:{text})});
function stream(events=[],{error,open=false}={}) {
  return new Response(new ReadableStream({start(controller){
    for(const event of events)controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(event)+'\n\n'));
    if(error)controller.error(error);else if(!open)controller.close();
  }}));
}
function harness({streams,history=()=>[],items=()=>[],session=()=>({status:'running'}),onSubmit}={}) {
  let submitted=0,connections=0;const reads=[],waits=[],reports=[];const progress=new Progress();
  const api={
    request:async()=>{connections++;const value=streams[connections-1];if(value instanceof Error)throw value;return typeof value==='function'?value():value;},
    json:async path=>{
      reads.push({path,connections,submitted});
      if(path.includes('/turns?'))return {data:history({submitted,connections}),has_more:false};
      if(path.includes('/items?'))return {data:items({submitted,connections}),has_more:false};
      return session({submitted,connections});
    }
  };
  const run=options=>followSessionTurn({api,sessionId:'sess',progress,submit:async()=>{submitted++;await onSubmit?.(submitted);},sleep:async ms=>waits.push(ms),report:async text=>reports.push(text),...options});
  return {api,run,progress,reads,waits,reports,get submitted(){return submitted;},get connections(){return connections;}};
}

test('clean disconnect reconnects without resubmitting and follows live root completion',async()=>{
  const h=harness({streams:[stream([textEvent('delta','Before')]),stream([textEvent('done','Recovered'),outcome()])]});
  await h.run();
  assert.equal(h.submitted,1);assert.equal(h.connections,2);assert.deepEqual(h.waits,[1000]);
  assert.equal(h.progress.message,'Recovered');assert.equal(h.progress.messages,1);
  assert.equal(h.reads.find(r=>r.path.includes('/items?')).connections,2);
});

test('completion missed during disconnect is recovered from saved root turn and paginated messages',async()=>{
  const h=harness({streams:[stream(),stream([],{open:true})],history:({submitted})=>submitted?[root('completed')]:[]});
  const original=h.api.json;
  h.api.json=async path=>{
    if(path.includes('/items?'))return path.includes('&after=') ? {data:[message('Saved final report')],has_more:false} : {data:[message('Earlier message','first')],has_more:true,last_id:'first'};
    return original(path);
  };
  await h.run();
  assert.equal(h.submitted,1);assert.equal(h.progress.message,'Saved final report');assert.equal(h.progress.messages,2);
});

test('completion during history retrieval uses the buffered live events',async()=>{
  let controller;
  const h=harness({streams:[stream(),()=>new Response(new ReadableStream({start(value){controller=value;}}))],history:({submitted})=>submitted?[root('in_progress')]:[]});
  const original=h.api.json;
  h.api.json=async path=>{
    if(path.includes('/items?')) {
      controller.enqueue(new TextEncoder().encode([textEvent('done','Completed during recovery'),outcome()].map(event=>'data: '+JSON.stringify(event)+'\n\n').join('')));
      controller.close();
    }
    return original(path);
  };
  await h.run();assert.equal(h.progress.message,'Completed during recovery');assert.equal(h.submitted,1);
});

test('previous and subagent completion, or idle session, cannot finish the submitted root turn',async()=>{
  const old=root('completed','previous');
  const h=harness({streams:[stream(),stream([outcome('completed','previous'),{type:'agent.session.turn.completed',turn:{id:'child',subagent_id:'sub'}},{type:'agent.session.idle'}]),stream([outcome()])],
    history:({submitted})=>submitted?[old,{id:'child',status:'completed',subagent_id:'sub'},root('in_progress')]:[old],session:()=>({status:'idle'})});
  await h.run();assert.equal(h.connections,3);assert.equal(h.submitted,1);assert.deepEqual(h.waits,[1000,2000]);
});

test('buffered deltas cannot duplicate or regress restored complete or partial output',async()=>{
  const h=harness({streams:[stream(),stream([textEvent('delta','duplicate','complete'),textEvent('done','stale','complete'),textEvent('delta','overlap','partial'),textEvent('done','Full partial message','partial'),outcome()])],
    items:()=>[message('Final message','complete'),message('Partial message','partial','in_progress')]});
  await h.run();assert.equal(h.progress.parts.get('complete:0:0'),'Final message');
  assert.equal(h.progress.parts.get('partial:0:0'),'Full partial message');assert.equal(h.progress.messages,2);
});

test('stream read errors and failed reconnect requests retry, with bounded backoff',async()=>{
  const h=harness({streams:[stream([],{error:new TypeError('terminated')}),new TypeError('fetch failed'),stream([outcome()])]});
  await h.run();assert.deepEqual(h.waits,[1000,2000]);assert.equal(h.submitted,1);
  const exhausted=harness({streams:[stream(),stream(),stream()]});
  await assert.rejects(exhausted.run({maxReconnects:2}),/recovery exhausted after 2 automatic reconnects/);
  assert.equal(exhausted.connections,3);assert.equal(exhausted.submitted,1);
});

test('lost submission response retries the same submission without changing its turn baseline',async()=>{
  const h=harness({streams:[stream(),stream([],{open:true})],onSubmit:async n=>{if(n===1)throw new TypeError('fetch failed');},history:({submitted})=>submitted?[root('completed')]:[]});
  await h.run();assert.equal(h.submitted,2);assert.equal(h.connections,2);
  assert.equal(h.reads.filter(r=>r.path.includes('/turns?') && r.submitted===0).length,1);
});

test('saved failed and cancelled turns and failed sessions stop recovery immediately',async()=>{
  for(const status of ['failed','cancelled']) {
    const h=harness({streams:[stream(),stream([],{open:true})],history:({submitted})=>submitted?[root(status,'current',{message:'durable failure',code:'specific'})]:[]});
    await assert.rejects(h.run(),error=>error.message==='durable failure' && error.code==='specific');
    assert.equal(h.connections,2);
  }
  const h=harness({streams:[stream(),stream([],{open:true})],session:()=>({status:'failed',error:{message:'session lost'}})});
  await assert.rejects(h.run(),/session lost/);assert.equal(h.connections,2);
});

test('live rate limits and permanent HTTP errors remain failures, not transport reconnects',async()=>{
  const limited={type:'agent.session.turn.failed',turn:root('failed','current',{message:'Rate limited',code:'rate_limit_exceeded'})};
  const h=harness({streams:[stream([limited])]});
  await assert.rejects(h.run(),error=>error.code==='rate_limit_exceeded');assert.equal(h.connections,1);
  const denied=harness({streams:[Object.assign(new Error('Unauthorized'),{status:401})]});
  await assert.rejects(denied.run(),/Unauthorized/);assert.equal(denied.submitted,0);assert.equal(denied.connections,1);
});

test('recovery restores required_actions and rejects unsupported actions',async()=>{
  const h=harness({streams:[stream(),stream([outcome()])],session:()=>({status:'requires_action',required_actions:[{type:'environment_connection'}]})});
  await h.run();assert.ok(h.reports.includes('Waiting for the executor connection…'));
  const unsupported=harness({streams:[stream(),stream([],{open:true})],session:()=>({status:'requires_action',required_actions:[{type:'function_call'}]})});
  await assert.rejects(unsupported.run(),/Unsupported required action: function_call/);
});

test('stopping during reconnect backoff prevents another connection or submission',async()=>{
  const controller=new AbortController();const h=harness({streams:[stream()]});
  await assert.rejects(h.run({signal:controller.signal,report:async()=>controller.abort(new Error('Executor exited'))}),/Executor exited/);
  assert.equal(h.connections,1);assert.equal(h.submitted,1);
});

test('stopping during a connected recovery cancels the blocked reader',async()=>{
  const controller=new AbortController();
  const h=harness({streams:[stream(),stream([],{open:true})]});
  const original=h.api.json;
  h.api.json=async path=>{if(path.includes('/items?'))controller.abort(new Error('Agent run exceeded timeout'));return original(path);};
  await assert.rejects(h.run({signal:controller.signal}),/Agent run exceeded timeout/);
  assert.equal(h.connections,2);assert.equal(h.submitted,1);
});
