import test from 'node:test';
import assert from 'node:assert/strict';
import {trigger,titleFor,render,readState,Progress,sse,START} from '../src/core.mjs';
const sender={type:'User'};
test('issue labels, mentions, review requests and inline followups',()=>{
  assert.equal(trigger('issues',{sender,action:'labeled',label:{name:'codex'},issue:{number:7}}).kind,'issue');
  assert.equal(trigger('issue_comment',{sender,action:'created',issue:{number:7,pull_request:{}},comment:{body:'@Codex fix'}}).kind,'pr');
  assert.equal(trigger('pull_request_review',{sender,action:'submitted',review:{state:'changes_requested'},pull_request:{number:9}}).number,9);
  assert.equal(trigger('pull_request_review_comment',{sender,action:'created',comment:{body:'@codex fix'},pull_request:{number:9}}).number,9);
  assert.equal(trigger('issue_comment',{sender,action:'created',issue:{number:7},comment:{body:'@codexish'}}),null);
  assert.equal(trigger('issues',{sender:{type:'Bot'},action:'labeled',label:{name:'codex'},issue:{number:7}}),null);
});
test('agent aliases trigger issues and followups without matching unrelated mentions',()=>{
  assert.equal(trigger('issues',{sender,action:'labeled',label:{name:'agent'},issue:{number:7}}).number,7);
  assert.equal(trigger('issues',{sender,action:'opened',issue:{number:7,title:'@agent fix this'}}).number,7);
  assert.equal(trigger('issues',{sender,action:'opened',issue:{number:7,labels:[{name:'agent'}]}}).number,7);
  for(const name of ['issue_comment','pull_request_review_comment','pull_request_review']) {
    const e={sender,action:name==='pull_request_review'?'submitted':'created',issue:{number:7},pull_request:{number:9},comment:{body:'@Agent fix'},review:{state:'commented',body:'@agent fix'}};
    assert.ok(trigger(name,e));
  }
  assert.equal(trigger('issue_comment',{sender,action:'created',issue:{number:7},comment:{body:'@agentish'}}),null);
  assert.equal(trigger('issues',{sender:{type:'Bot'},action:'labeled',label:{name:'agent'},issue:{number:7}}),null);
});
test('status changes replace prefixes',()=>{
  assert.equal(titleFor('[ERROR] [WIP] Task','running'),'[WIP] Task');
  assert.equal(titleFor('[WIP] Task','done'),'Task');
  assert.equal(titleFor('[WIP] Task','error'),'[ERROR] Task');
});
test('status refresh preserves human description and session mapping',()=>{
  const state={version:1,issue:7,sessionId:'sess_123'};
  const p={phase:'running',started:1000,lastMessage:2000,message:'Working',messages:2,runUrl:'https://github.com/run',usage:{input_tokens:100,output_tokens:20,total_tokens:120}};
  const first=render('Human notes',state,p,4000);
  const second=render(first,state,{...p,message:'Done'},5000);
  assert.equal(second.split(START).length,2);
  assert.equal(second.split('codex-state:').length,2);
  assert.match(second,/\[OpenAI session logs\]\(https:\/\/platform.openai.com\/logs\?api=agents\)/);
  assert.match(second,/Session: `sess_123`/);
  assert.doesNotMatch(render('',{version:1,issue:7},p,4000),/OpenAI session logs/);
  assert.match(second,/Human notes/);assert.match(second,/120 total/);assert.match(second,/Done/);
  assert.deepEqual(readState(second),state);
  assert.match(render('',state,{...p,usage:null},4000),/not reported yet/);
});
test('messages are replaced by content identity, not concatenated across messages',()=>{
  const p=new Progress();
  p.consume({type:'agent.session.turn.output_text.delta',item_id:'a',output_index:0,content_index:0,delta:'Hel'},10);
  p.consume({type:'agent.session.turn.output_text.done',item_id:'a',output_index:0,content_index:0,text:'Hello'},20);
  p.consume({type:'agent.session.turn.output_text.done',item_id:'b',output_index:0,content_index:0,text:'Finished'},30);
  assert.equal(p.message,'Finished');assert.equal(p.messages,2);assert.equal(p.lastMessage,30);
  assert.equal(p.consume({type:'agent.session.turn.completed',turn:{subagent_id:'child'}}),undefined);
  assert.equal(p.consume({type:'agent.session.turn.completed',turn:{subagent_id:null}}),'done');
  assert.throws(()=>p.consume({type:'agent.session.turn.failed',turn:{subagent_id:null,error:{message:'failed'}}}),/failed/);
  assert.throws(()=>p.consume({type:'agent.session.requires_action'}),/Unsupported required action/);
});
test('SSE supports chunk boundaries, unicode, CRLF and keepalive',async()=>{
  const bytes=Buffer.from(': ping\r\n\r\ndata: {"type":"text","text":"修仙"}\r\n\r\ndata: [DONE]\n\n');
  async function* chunks(){for(let i=0;i<bytes.length;i++)yield bytes.subarray(i,i+1);}
  const events=[];for await(const e of sse(chunks())) events.push(e);
  assert.deepEqual(events,[{type:'text',text:'修仙'}]);
});

test('connection requests wait while unsupported actions and real failures stop',()=>{
  const p=new Progress();
  assert.equal(p.consume({type:'agent.session.requires_action',required_action:{type:'environment_connection'}}),'waiting');
  assert.equal(p.consume({type:'agent.session.requires_action',required_action:{type:'resolved'}}),undefined);
  assert.equal(p.consume({type:'agent.session.environment.connected'}),undefined);
  assert.equal(p.consume({type:'agent.session.turn.completed',turn:{subagent_id:null}}),'done');
  assert.throws(()=>p.consume({type:'agent.session.requires_action',required_action:{type:'function_call'}}),/function_call/);
  assert.throws(()=>p.consume({type:'agent.session.environment.failed',error:{message:'connection failed'}}),/connection failed/);
});
