export const START = '<!-- codex-status:start -->';
export const END = '<!-- codex-status:end -->';
export function trigger(name, e) {
  if (e.sender?.type === 'Bot') return null;
  const mention = /(^|\s)@(?:agent|codex)\b/i;
  if (name === 'issues' && e.action === 'labeled' && ['agent','codex'].includes(e.label?.name)) return {number:e.issue.number, kind:'issue', text:e.issue.body ?? ''};
  if (name === 'issues' && e.action === 'opened' && (e.issue.labels?.some(label=>['agent','codex'].includes(label.name)) || mention.test(e.issue.body ?? '') || mention.test(e.issue.title ?? ''))) return {number:e.issue.number, kind:'issue', text:e.issue.body ?? ''};
  if (name === 'issue_comment' && e.action === 'created' && mention.test(e.comment.body)) return {number:e.issue.number, kind:e.issue.pull_request ? 'pr':'issue', text:e.comment.body};
  if (name === 'pull_request_review' && e.action === 'submitted' && (e.review.state === 'changes_requested' || mention.test(e.review.body ?? ''))) return {number:e.pull_request.number, kind:'pr', text:e.review.body ?? 'Implement the requested changes in this review.'};
  if (name === 'pull_request_review_comment' && e.action === 'created' && mention.test(e.comment.body)) return {number:e.pull_request.number, kind:'pr', text:e.comment.body};
  return null;
}
export function cleanTitle(title) { return title.replace(/^(?:\[(?:WIP|ERROR)\]\s*)+/i, ''); }
export function titleFor(title, phase) { return (phase === 'done' ? '' : phase === 'error' ? '[ERROR] ' : '[WIP] ') + cleanTitle(title); }
export function readState(body = '') {
  const raw = body.match(/<!-- codex-state:([A-Za-z0-9+/=]+) -->/)?.[1];
  if (!raw) return null;
  const state = JSON.parse(Buffer.from(raw,'base64').toString());
  if (state.version !== 1 || typeof state.issue !== 'number') throw new Error('Invalid saved Codex state');
  return state;
}
export function duration(ms) { const s=Math.max(0,Math.floor(ms/1000)); return `${Math.floor(s/60)}m ${s%60}s`; }
export function render(body, state, progress, now=Date.now()) {
  const previous = body.indexOf(START), end=body.indexOf(END, previous);
  let rest = previous >= 0 && end >= 0 ? body.slice(0,previous)+body.slice(end+END.length) : body;
  rest=rest.replace(/<!-- codex-state:[A-Za-z0-9+/=]+ -->/g,'').trim();
  const u=progress.usage;
  const tokens=u ? `${u.total_tokens ?? u.input_tokens+u.output_tokens} total (${u.input_tokens} input / ${u.output_tokens} output)` : 'not reported yet';
  const lines=[START,`**Codex: ${progress.phase}** · [Workflow run](${progress.runUrl})`, '', '| Elapsed this run | Since last message | Session tokens | Messages this run |', '| --- | --- | --- | --- |', `| ${duration(now-progress.started)} | ${progress.lastMessage ? duration(now-progress.lastMessage) : 'awaiting first message'} | ${tokens} | ${progress.messages ?? 0} |`, '', '### Latest agent message', '', (progress.message || 'Preparing the executor…').slice(-18000), END];
  return `${lines.join('\n')}\n\n${rest}\n\n<!-- codex-state:${Buffer.from(JSON.stringify(state)).toString('base64')} -->`;
}
export class Progress {
  constructor() { this.parts=new Map(); this.messages=0; }
  consume(e, now=Date.now()) {
    if (/^agent\.session\.turn\.output_text\.(delta|done)$/.test(e.type)) {
      const k=`${e.item_id}:${e.output_index}:${e.content_index}`;
      if (!this.parts.has(k)) this.messages++;
      const text=e.type.endsWith('.done') ? e.text : (this.parts.get(k) ?? '')+e.delta;
      this.parts.set(k,text); this.message=text; this.lastMessage=now;
    }
    if (e.turn?.usage) this.turnUsage=e.turn.usage;
    if (e.type === 'agent.session.turn.completed' && e.turn?.subagent_id == null) return 'done';
    if (['agent.session.turn.failed','agent.session.turn.cancelled'].includes(e.type) && e.turn?.subagent_id == null) throw new Error(e.turn?.error?.message ?? e.type);
    if (e.type === 'agent.session.requires_action') {
      const action=e.required_action?.type;
      if(action==='environment_connection') return 'waiting';
      if(action==='resolved') return;
      throw new Error(`Unsupported required action: ${action ?? 'unknown'}`);
    }
    if (['error','agent.session.failed','agent.session.environment.failed'].includes(e.type)) throw new Error(e.error?.message ?? e.type);
  }
}
export async function* sse(body) {
  const decoder=new TextDecoder(); let buffer='';
  for await (const chunk of body) {
    buffer+=decoder.decode(chunk,{stream:true}); buffer=buffer.replace(/\r\n/g,'\n');
    let i;
    while ((i=buffer.indexOf('\n\n'))>=0) {
      const frame=buffer.slice(0,i); buffer=buffer.slice(i+2);
      const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
  }
}
