import test from 'node:test';
import assert from 'node:assert/strict';
import {Accounting,estimateCost,listTurns,sumUsage,tokenText} from '../src/usage.mjs';
const usage=(input,output,cached=0)=>({input_tokens:input,output_tokens:output,input_tokens_details:{cached_tokens:cached}});
test('cost discounts cached input and bills reasoning within output only',()=>{
 assert.equal(estimateCost(usage(1000000,1000000,500000),'gpt-6-luna'),0.555);
 assert.equal(estimateCost(null,'gpt-6-luna'),null);
 assert.equal(estimateCost(usage(1,1),'unknown'),null);
 assert.equal(sumUsage([null,null]),null);assert.equal(tokenText({}),'not reported yet');
});
test('cursor pagination accounts for all turns',async()=>{
 const paths=[];const api={json:async path=>{paths.push(path);return paths.length===1?{data:[{id:'a'}],has_more:true,last_id:'a'}:{data:[{id:'b'}],has_more:false};}};
 assert.deepEqual((await listTurns(api,'sess')).map(t=>t.id),['a','b']);assert.match(paths[1],/after=a/);
});
test('run accounting deduplicates retries and subagents, retains late usage and excludes past turns',async()=>{
 const prior={id:'old',usage:usage(100,10)};let turns=[prior];
 const api={json:async path=>path.includes('/turns?')?{data:turns,has_more:false}:{usage:null}};
 const run={model:'gpt-6-luna',turnIds:[]},state={runs:[run]},progress={};const a=new Accounting(progress,state,run);
 await a.start(api,{id:'s',agent:{model:'gpt-6-luna'},usage:null});
 const root={id:'root',usage:usage(20,5)},child={id:'child',subagent_id:'child',usage:usage(10,2)},retry={id:'retry',usage:null};
 a.consume(root);a.consume(root);a.consume(child);a.consume(retry);turns=[prior,root,child,retry];
 await a.refresh(api,{id:'s'});assert.equal(run.usage.total_tokens,37);assert.equal(run.partial,true);assert.equal(run.turnIds.length,3);
 turns=[prior,root,child,{...retry,usage:usage(3,1)}];await a.refresh(api,{id:'s'});
 assert.equal(run.usage.total_tokens,41);assert.equal(run.partial,false);assert.equal(progress.usage.total_tokens,151);
 // A subsequent unknown snapshot must not erase known accounting.
 turns=[prior,{id:'root',usage:null},child,{id:'retry',usage:null}];await a.refresh(api,{id:'s'});assert.equal(run.usage.total_tokens,41);
});
