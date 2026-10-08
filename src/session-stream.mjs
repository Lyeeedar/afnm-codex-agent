import {setTimeout as delay} from 'node:timers/promises';
import {sse} from './core.mjs';
import {listTurns} from './usage.mjs';

class TransportFailure extends Error {
  constructor(cause) {super(cause.message,{cause});}
}
function transient(error) {
  return error instanceof TypeError || error.name==='TimeoutError' || error.status===429 || error.status>=500 ||
    /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_)/.test(error.code ?? error.cause?.code ?? '');
}
async function transport(operation) {
  try {return await operation();}
  catch(error) {if(transient(error))throw new TransportFailure(error);throw error;}
}
async function listItems(api,id,signal) {
  const items=[];let after;const cursors=new Set();
  for(;;) {
    const page=await api.json(`/agents/sessions/${id}/items?limit=100&order=asc${after?'&after='+encodeURIComponent(after):''}`,{signal});
    if(!Array.isArray(page?.data))throw new Error('Invalid saved item response');
    items.push(...page.data);
    if(!page.has_more)return items;
    if(!page.last_id || cursors.has(page.last_id))throw new Error('Invalid saved item cursor');
    after=page.last_id;cursors.add(after);
  }
}
function pendingActions(session) {
  return session.required_actions ?? (session.required_action ? [session.required_action] : []);
}

// Streams contain only live events. Subscribe before inspecting saved history,
// buffer the next event, and use the submitted turn's durable status for recovery.
export async function followSessionTurn({api,sessionId,progress,submit,onSubmitted=async()=>{},report=async()=>{},signal,
  maxReconnects=6,sleep=delay,baseDelayMs=1000,maxDelayMs=30000}) {
  const path=`/agents/sessions/${sessionId}`;
  let baseline,sent=false;
  const finalized=new Set(), restoredPartial=new Set();
  const consume=async event=>{
    if(baseline.has(event.turn?.id) || baseline.has(event.turn_id))return;
    if(event.item_id && (finalized.has(event.item_id) ||
      (restoredPartial.has(event.item_id) && event.type==='agent.session.turn.output_text.delta')))return;
    if(event.type==='agent.session.requires_action' && !event.required_action) {
      const current=await transport(()=>api.json(path,{signal}));
      if(current.status==='failed')throw new Error(current.error?.message ?? 'Agent session failed');
      const actions=pendingActions(current);
      if(actions.length) {
        for(const action of actions)if(progress.consume({...event,required_action:action})==='waiting')await report('Waiting for the executor connection…');
        return;
      }
      event={...event,required_action:current.status!=='requires_action' ? {type:'resolved'} : undefined};
    }
    const outcome=progress.consume(event);
    if(outcome==='waiting')await report('Waiting for the executor connection…');
    return outcome;
  };
  for(let reconnect=0;;reconnect++) {
    signal?.throwIfAborted();
    const connection=new AbortController();
    const connectionSignal=signal ? AbortSignal.any([signal,connection.signal]) : connection.signal;
    let reader,events,pending,stopReading;
    try {
      // Keep this baseline fixed even if a submission response is lost: retrying
      // an idempotent submission must not turn its accepted turn into old history.
      baseline ??=new Set((await transport(()=>listTurns(api,sessionId,{signal}))).map(turn=>turn.id));
      const response=await transport(()=>api.request(`${path}/events?stream=true`,{headers:{Accept:'text/event-stream'},signal:connectionSignal}));
      reader=response.body.getReader();
      stopReading=()=>{reader.cancel().catch(()=>{});};
      connectionSignal.addEventListener('abort',stopReading,{once:true});
      if(connectionSignal.aborted)stopReading();
      async function* chunks() {for(;;){const chunk=await reader.read();if(chunk.done)return;yield chunk.value;}}
      events=sse(chunks());
      const next=()=>events.next().then(result=>({result}),error=>({error}));
      pending=next();
      if(!sent) {
        await transport(()=>submit());sent=true;
        await onSubmitted();
      }
      if(reconnect>0) {
        const current=await transport(()=>api.json(path,{signal}));
        if(current.status==='failed')throw new Error(current.error?.message ?? 'Agent session failed');
        const actions=pendingActions(current);
        if(current.status==='requires_action' && !actions.length)throw new Error('Unsupported required action: unknown');
        for(const action of actions)await consume({type:'agent.session.requires_action',required_action:action});
        // Inspect turns before items so a terminal snapshot is followed by a
        // fresh read of its final report, rather than an earlier partial item.
        const turns=await transport(()=>listTurns(api,sessionId,{signal}));
        const items=await transport(()=>listItems(api,sessionId,signal));
        for(const item of items) {
          if(item.type!=='message' || item.role!=='assistant' || baseline.has(item.turn_id))continue;
          for(const [index,content] of (item.content ?? []).entries()) {
            if(content.type==='output_text')progress.consume({type:'agent.session.turn.output_text.done',item_id:item.id,output_index:0,content_index:index,text:content.text});
          }
          if(item.status==='completed')finalized.add(item.id);
          else restoredPartial.add(item.id);
        }
        for(const turn of turns) {
          if(baseline.has(turn.id) || turn.subagent_id!=null)continue;
          progress.accounting?.consume(turn,true);
          signal?.throwIfAborted();
          if(['completed','failed','cancelled'].includes(turn.status) &&
            await consume({type:`agent.session.turn.${turn.status}`,turn})==='done')return;
        }
      }
      for(;;) {
        const {result,error}=await pending;
        signal?.throwIfAborted();
        if(error) {if(transient(error))throw new TransportFailure(error);throw error;}
        if(result.done)throw new TransportFailure(new Error('Event stream disconnected before completion'));
        pending=next();
        if(await consume(result.value)==='done')return;
      }
    } catch(error) {
      signal?.throwIfAborted();
      if(!(error instanceof TransportFailure))throw error;
      if(reconnect>=maxReconnects)throw new Error(`Event stream recovery exhausted after ${maxReconnects} automatic reconnects: ${error.message}`,{cause:error});
    } finally {
      connection.abort();
      if(stopReading)connectionSignal.removeEventListener('abort',stopReading);
      await reader?.cancel().catch(()=>{});
      await pending;
      await events?.return().catch(()=>{});
      reader?.releaseLock();
    }
    const wait=Math.min(maxDelayMs,baseDelayMs*2**reconnect);
    await report(`Event stream disconnected. Automatic reconnect ${reconnect+1}/${maxReconnects} in ${Math.ceil(wait/1000)} seconds; preserving this session, executor and checkout…`);
    signal?.throwIfAborted();
    await sleep(wait,undefined,{signal});
  }
}
