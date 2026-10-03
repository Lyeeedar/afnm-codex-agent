import test from 'node:test';
import assert from 'node:assert/strict';
import {createStateTools,patchState} from '../preview/state.mjs';
import {installPreviewBridge} from '../preview/bridge.mjs';
import {previewStateTools} from '../preview/state-plugin.mjs';
const initial=()=>({newGame:{characterCreated:true,imageId:'avatar'},player:{player:{realm:'bodyForging'}},location:{current:'Sect'},screen:{screen:'location'},house:{inHouse:false},gameData:{flags:{}},inventory:{money:1,items:[]},combat:{},crafting:{},gameEvent:{},auction:{},tournament:{},dualCultivation:{},stoneCutting:{},formationPuzzle:{},guild:{},soulShardDelve:{},mysticalRegion:{},expedition:{}});
function harness(){
  let state=initial(),commits=0;
  const reduce=(action,current)=>action.type==='debug/commitState'||action.type==='RESTORE_STATE'?action.payload:action.type==='navigate'?{...current,screen:{screen:action.payload}}:action.type==='skip'?{...current,player:{player:{realm:action.payload}}}:action.type==='money'?{...current,inventory:{...current.inventory,money:current.inventory.money+action.payload}}:action.type==='flag'?{...current,gameData:{flags:{...current.gameData.flags,[action.payload.flag]:action.payload.value}}}:current;
  const store={getState:()=>state,dispatch:action=>{if(typeof action==='function')return action(store.dispatch,store.getState);state=reduce(action,state);commits++;return action;}};
  const modules={
    '/src/store/index.ts':{rootReducer:()=>initial()},
    '/src/store/debugState.ts':{commitDebugState:payload=>({type:'debug/commitState',payload})},
    '/src/store/debugTransaction.ts':{runDebugTransaction:operation=>(dispatch,getState)=>{let staged=getState();const localDispatch=action=>{if(typeof action==='function')return action(localDispatch,()=>staged);staged=reduce(action,staged);return action;};operation(localDispatch,()=>staged);dispatch({type:'debug/commitState',payload:staged});}},
    '/src/util/determineCurrentScreen.ts':{determineCurrentScreen:s=>s.combat.playerState?'combat':s.screen.screen},
    '/src/data/locations/locations.ts':{locationMap:{Sect:{name:'Sect',buildings:[{kind:'library',title:'Test Library'}]}},locations:[{name:'Sect',buildings:[{kind:'library',title:'Test Library'}]}]},
    '/src/store/slices/playerSlice.ts':{},
    '/src/store/slices/inventorySlice.ts':{addMoney:payload=>({type:'money',payload})},
    '/src/store/slices/locationSlice.ts':{},
    '/src/store/slices/screenSlice.ts':{navigate:payload=>({type:'navigate',payload})},
    '/src/store/slices/gameDataSlice.ts':{setFlag:payload=>({type:'flag',payload})},
    '/src/components/game/debugRealmSkip.ts':{debugSkipRealms:['bodyForging','coreFormation'],skipToRealm:payload=>({type:'skip',payload})},
    '/src/data/items/items.ts':{items:[{name:'Pill'},{name:'Sword'}],itemMap:{Pill:{name:'Pill'}}},
    '/src/data/techniques/none/newGame.ts':{qiPunch:{name:'Qi Punch'},qiBlock:{name:'Qi Block'}},
    '/src/data/crafting/newGameActions.ts':{newGameActions:[{name:'Simple Fusion'}]},
    '/src/util/newGamePointBuy.ts':{initialStartingStats:{flesh:8}},
    '/src/store/slices/sectSlice.ts':{initializeSectState:()=>({type:'noop'})},
  };
  return {tools:createStateTools({store,load:async path=>{if(!modules[path])throw new Error('Missing mock '+path);return modules[path];}}),store,commits:()=>commits};
}
test('current setup applies real actions in one commit and preserves unrelated report fields',async()=>{
  const {tools,store,commits}=harness();
  await tools.apply({base:'current',screen:'library',money:100,flags:{unlock:1},patch:{'player.player.testValue':5}});
  assert.equal(commits(),1);assert.equal(store.getState().inventory.money,100);assert.equal(store.getState().player.player.testValue,5);assert.equal(store.getState().location.current,'Sect');assert.equal((await tools.inspect()).screen,'library');
});
test('screen prerequisites fail atomically, preserving the original active fight',async()=>{
  const {tools,store,commits}=harness();store.getState().combat.playerState={};
  const before=tools.snapshot();
  await assert.rejects(tools.apply({base:'current',screen:'library',money:100}),/selects combat/);
  assert.deepEqual(store.getState(),before);assert.equal(commits(),0);
  await tools.apply({base:'current',screen:'library',clearActivities:true});
  assert.equal((await tools.inspect()).screen,'library');
});
test('unsupported progression never labels a fresh late-game build as valid',async()=>{
  const {tools,store,commits}=harness();const before=tools.snapshot();
  await assert.rejects(tools.apply({base:'current',realm:'soulAscension'}),/No authored progression preset/);
  assert.deepEqual(store.getState(),before);assert.equal(commits(),0);
});
test('a combat screen label alone cannot bypass the required fight initializer',async()=>{
  const {tools,store,commits}=harness();const before=tools.snapshot();
  await assert.rejects(tools.apply({base:'current',screen:'combat',money:0}),/missing its active state/);
  assert.deepEqual(store.getState(),before);assert.equal(commits(),0);
});
test('catalog discovery, checkpoints and custom real thunk operations work independently',async()=>{
  const {tools}=harness();const checkpoint=tools.snapshot();
  assert.equal((await tools.catalog('items','pill')).matches[0].name,'Pill');
  await tools.apply({base:'current',operations:[{module:'/src/store/slices/screenSlice.ts',export:'navigate',args:['map']}]});
  assert.equal((await tools.inspect()).screen,'map');
  await tools.restore(checkpoint);assert.equal((await tools.inspect()).screen,'location');
  await assert.rejects(tools.apply({operations:[{module:'/src/../secret.ts',export:'anything'}]}),/absolute \/src\/ path/);
});
test('patches replace arrays, reject typos and prevent prototype writes',()=>{
  const state={inventory:{items:['old']}};
  assert.deepEqual(patchState(state,{'inventory.items':['new']}).inventory.items,['new']);
  assert.throws(()=>patchState(state,{'inventory.missing.name':'bad'}),/Unknown state path/);
  assert.throws(()=>patchState(state,{'__proto__.polluted':true}),/Unsafe state path/);
  assert.equal({}.polluted,undefined);
});
test('preview saves survive page reload inside the tab while preserving the supplied report',async()=>{
  const previous=global.window;const data=new Map();global.window={sessionStorage:{getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)}};
  try{
    installPreviewBridge({version:'1',saveData:'{"report":true}'});
    window.__agentPreview.setSave('agent-preview-scenario','{"scenario":true}');
    await window.myFS.writeSave('agent-preview-report','{"report":"updated"}');
    installPreviewBridge({version:'1',saveData:'{"report":true}'});
    assert.equal(await window.myFS.readSave('agent-preview-scenario'),' {"scenario":true}'.trim());
    assert.equal(await window.myFS.readSave('agent-preview-report'),'{"report":"updated"}');
  }finally{global.window=previous;}
});
test('the preview save-loader adapter only patches the known router and fails if its interface changes',()=>{
  const plugin=previewStateTools();
  assert.equal(plugin.transform('unrelated','/src/Other.tsx'),null);
  assert.match(plugin.transform('const reduxState = useSaveReducer(saveName);','/src/components/contexts/saves/SaveRouter.tsx').code,/loadSave = setSaveName/);
  assert.throws(()=>plugin.transform('changed upstream','/src/components/contexts/saves/SaveRouter.tsx'),/adapter update/);
});
test('fresh scenarios stamp the running game version so save loading cannot apply legacy migrations',async()=>{
  const previous=global.window;global.window={app:{getVersion:async()=>'0.7.15'}};
  try{
    const {tools}=harness();await tools.apply({base:'fresh',realm:'coreFormation',screen:'library'});
    assert.equal(tools.snapshot().version.version,'0.7.15');
  }finally{global.window=previous;}
});

test('preview trigger guards only affect the two automatic trigger components',()=>{
 const plugin=previewStateTools();
 for(const path of ['/src/components/game/EventTrigger.tsx','/src/components/tutorial/TutorialTrigger.tsx'])assert.match(plugin.transform('useErrorHandlingEffect(() => { run(); })',path).code,/pauseTriggers/);
 assert.equal(plugin.transform('useErrorHandlingEffect(() => { run(); })','/src/Other.tsx'),null);
});

test('library setup rejects a location without its required building before committing',async()=>{
 const {tools,store,commits}=harness();store.getState().location.current='NoLibrary';const before=tools.snapshot();
 await assert.rejects(tools.apply({base:'current',screen:'library',money:99}),/no library building/);
 assert.deepEqual(store.getState(),before);assert.equal(commits(),0);
 assert.equal((await tools.catalog('locations','Sect')).matches[0].buildings[0].kind,'library');
});
