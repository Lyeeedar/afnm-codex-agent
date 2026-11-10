import test from 'node:test';
import assert from 'node:assert/strict';
import {preparePreviewSave} from '../preview/migration.mjs';
import {previewStateTools} from '../preview/state-plugin.mjs';
import {startupTimeout} from '../preview/startup.mjs';

function fixture({realm='coreFormation',forged={},opened={},migration}={}) {
  const stats=['eyes','meridians','dantian','muscles','digestion','flesh'];
  let state={player:{player:{realm,physicalStats:{flesh:30,muscles:20,dantian:10}}},breakthrough:{migration,bodyForging:{forging:{forgedStats:forged}},greaterMeridianOpening:{opened}},unrelated:{report:true}};
  const selected=s=>stats.filter(stat=>s.breakthrough.bodyForging.forging.forgedStats[stat]);
  const awakened=(b,stat)=>['first','existing'].includes(b.greaterMeridianOpening.opened[stat])?b.greaterMeridianOpening.opened[stat]:undefined;
  const stage=(_realm,b)=> {
    if(_realm==='bodyForging')return;
    if(b.migration==='bodyForging' || !stats.some(stat=>b.bodyForging.forging.forgedStats[stat]))return 'bodyForging';
    if(_realm!=='meridianOpening' && (b.migration==='meridianOpening' || stats.some(stat=>b.bodyForging.forging.forgedStats[stat] && !awakened(b,stat))))return 'meridianOpening';
  };
  const actions={
    migrateForgedStat:stat=>(_dispatch,get)=>{
      const s=get();if(selected(s).length>=3 || s.breakthrough.bodyForging.forging.forgedStats[stat])return false;
      s.breakthrough.migration='bodyForging';s.breakthrough.bodyForging.forging.forgedStats[stat]=true;return true;
    },
    migrateMeridianAwakening:(stat,path)=>(_dispatch,get)=>{get().breakthrough.greaterMeridianOpening.opened[stat]=path;get().breakthrough.migration='meridianOpening';return true;},
    completeBreakthroughMigration:()=>(_dispatch,get)=>{const s=get();if(stage(s.player.player.realm,s.breakthrough)==='bodyForging' && selected(s).length!==3)return false;s.breakthrough.migration=undefined;return true;},
  };
  const definitions=Object.fromEntries(stats.map(stat=>[stat,{paths:{first:{},existing:{}}}]));
  const modules={
    '/src/util/breakthroughMigration.ts':{getBreakthroughMigrationStage:stage},
    '/src/types/stat.ts':{physicalStatistics:stats},
    '/src/data/thresholdEffects/forgedStats.ts':{forgedStats:definitions},
    '/src/store/slices/breakthroughMigrationActions.ts':actions,
    '/src/util/getMeridianEffects.ts':{getAwakenedPath:awakened},
    '/src/store/debugTransaction.ts':{runDebugTransaction:fn=>()=>{const staged=structuredClone(state);const dispatch=action=>action(dispatch,()=>staged);fn(dispatch,()=>staged);state=staged;}},
  };
  const store={getState:()=>state,dispatch:action=>action(store.dispatch,store.getState)};
  return {store,definitions,run:()=>preparePreviewSave(store,async path=>modules[path])};
}

test('legacy preview saves complete both gates using strongest stats and disclose choices',async()=>{
  const f=fixture();const choices=await f.run();
  assert.deepEqual(choices.filter(c=>c.forged).map(c=>c.stat),['flesh','muscles','dantian']);
  assert.equal(choices.filter(c=>c.path).length,3);
  assert.deepEqual(f.store.getState().unrelated,{report:true});
  assert.deepEqual(await f.run(),[]);
});
test('partial migration preserves existing forged stats and valid awakening paths',async()=>{
  const f=fixture({forged:{eyes:true},opened:{eyes:'existing'},migration:'bodyForging'});
  const choices=await f.run();
  assert.deepEqual(choices.filter(c=>c.forged).map(c=>c.stat),['flesh','muscles']);
  assert.equal(f.store.getState().breakthrough.greaterMeridianOpening.opened.eyes,'existing');
});
test('early realms do not gain unearned breakthrough choices',async()=>{
  assert.deepEqual(await fixture({realm:'bodyForging'}).run(),[]);
  const choices=await fixture({realm:'meridianOpening'}).run();
  assert.equal(choices.length,3);assert.ok(choices.every(c=>c.forged));
});
test('missing awakening paths roll back the entire preview migration',async()=>{
  const f=fixture();const before=structuredClone(f.store.getState());f.definitions.flesh.paths={};
  await assert.rejects(f.run(),/could not awaken flesh/);
  assert.deepEqual(f.store.getState(),before);
});
test('preview adapters support current and legacy menu paths and fail on source drift',()=>{
  const plugin=previewStateTools();
  for(const path of ['/src/screens/MainMenuScreen.tsx','/src/screens/mainMenu/MainMenuScreen.tsx']) {
    const result=plugin.transform('export const MainMenuScreen: React.FC<MainMenuScreenProps> = (props) => {',path);
    assert.match(result.code,/menuReady = true/);
    assert.throws(()=>plugin.transform('changed',path),/readiness adapter changed/);
  }
  const path='/src/screens/cultivation/BreakthroughMigrationGate.tsx';
  assert.match(plugin.transform('  if (!stage) return children;',path).code,/preparePreviewSave\(window.gameStore\)/);
  assert.throws(()=>plugin.transform('changed',path),/migration adapter changed/);
});
test('startup shares a cold-start budget and honors validated overrides',()=>{
  assert.equal(startupTimeout({}),240000);
  assert.equal(startupTimeout({PREVIEW_READY_TIMEOUT_MS:'1200000'}),1200000);
  for(const value of ['0','-1','NaN','Infinity',''])assert.throws(()=>startupTimeout({PREVIEW_READY_TIMEOUT_MS:value}),/positive number/);
});
