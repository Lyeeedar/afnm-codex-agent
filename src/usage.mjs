// Standard short-context model rates, USD per million tokens, verified 2026-10-03.
// Agents turn totals do not expose per-call context length or cache writes.
const rates={'gpt-6-luna':[0.10,0.01,0.50]};
export function normalizeUsage(u) {
  if(!u || !Number.isFinite(u.input_tokens) || !Number.isFinite(u.output_tokens)) return null;
  return {input_tokens:u.input_tokens,output_tokens:u.output_tokens,total_tokens:u.total_tokens ?? u.input_tokens+u.output_tokens,input_tokens_details:{cached_tokens:u.input_tokens_details?.cached_tokens ?? 0}};
}
export function sumUsage(values) {
  const known=values.map(normalizeUsage).filter(Boolean);
  if(!known.length)return null;
  return known.reduce((a,u)=>({input_tokens:a.input_tokens+u.input_tokens,output_tokens:a.output_tokens+u.output_tokens,total_tokens:a.total_tokens+u.total_tokens,input_tokens_details:{cached_tokens:a.input_tokens_details.cached_tokens+u.input_tokens_details.cached_tokens}}),{input_tokens:0,output_tokens:0,total_tokens:0,input_tokens_details:{cached_tokens:0}});
}
export function estimateCost(u,model) {
  u=normalizeUsage(u);const r=rates[model];if(!u || !r)return null;
  const cached=Math.min(u.input_tokens,u.input_tokens_details.cached_tokens);
  return ((u.input_tokens-cached)*r[0]+cached*r[1]+u.output_tokens*r[2])/1e6;
}
export function tokenText(u) {
  u=normalizeUsage(u);return u ? `${u.total_tokens} total (${u.input_tokens} input / ${u.output_tokens} output / ${u.input_tokens_details.cached_tokens} cached)` : 'not reported yet';
}
export function costText(cost) {return Number.isFinite(cost)?`~$${cost.toFixed(6)} USD`:'not available yet';}
export async function listTurns(api,id) {
  const turns=[];let after;
  do {
    const page=await api.json(`/agents/sessions/${id}/turns?limit=100&order=asc${after?'&after='+encodeURIComponent(after):''}`);
    if(!Array.isArray(page?.data))throw new Error('Invalid turn accounting response');
    turns.push(...page.data);
    if(!page.has_more)return turns;
    if(!page.last_id || page.last_id===after)throw new Error('Invalid turn accounting cursor');
    after=page.last_id;
  }while(true);
}
export class Accounting {
  constructor(progress,state,run) {this.progress=progress;this.state=state;this.run=run;this.baseline=null;this.turns=new Map();}
  async start(api,session) {
    this.model=session.agent?.model ?? this.run.model;this.run.model=this.model;
    this.baselineUsage=normalizeUsage(session.usage);
    try {this.baseline=new Set((await listTurns(api,session.id)).map(t=>t.id));} catch {console.warn('Turn baseline unavailable; using session usage delta where possible.');}
  }
  consume(turn,isEvent=false) {
    if(!turn?.id)return;
    this.turns.set(turn.id,{...this.turns.get(turn.id),...turn,usage:turn.usage ?? this.turns.get(turn.id)?.usage});
    if((isEvent || (this.baseline && !this.baseline.has(turn.id))) && !this.run.turnIds.includes(turn.id))this.run.turnIds.push(turn.id);
  }
  async refresh(api,session) {
    let sessionUsage=null;
    try {const current=await api.json(`/agents/sessions/${session.id}`);const u=normalizeUsage(current.usage);if(u){this.progress.usage=u;sessionUsage=u;}}catch{}
    try {for(const t of await listTurns(api,session.id))this.consume(t);}catch{}
    const all=[...this.turns.values()];
    if(!sessionUsage){const u=sumUsage(all.map(t=>t.usage));if(u)this.progress.usage=u;}
    for(const run of this.state.runs ?? []) {
      const turns=run.turnIds.map(id=>this.turns.get(id));
      const u=sumUsage(turns.map(t=>t?.usage));
      if(u) {run.usage=u;run.partial=turns.some(t=>!normalizeUsage(t?.usage));run.cost=estimateCost(u,run.model);}
    }
    // No turn baseline: a known session baseline still permits run-only accounting.
    if(!this.run.turnIds.length && !this.baseline && this.baselineUsage && sessionUsage) {
      const a=this.progress.usage,b=this.baselineUsage;
      if(a.input_tokens>=b.input_tokens && a.output_tokens>=b.output_tokens) {
        this.run.usage={input_tokens:a.input_tokens-b.input_tokens,output_tokens:a.output_tokens-b.output_tokens,input_tokens_details:{cached_tokens:Math.max(0,a.input_tokens_details.cached_tokens-b.input_tokens_details.cached_tokens)}};
        this.run.cost=estimateCost(this.run.usage,this.model);
      }
    }
    this.progress.runUsage=this.run.usage;this.progress.runCost=this.run.cost;this.progress.partialUsage=this.run.partial;
  }
}
