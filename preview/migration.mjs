// Only the disposable preview uses these deterministic migration choices.
export async function preparePreviewSave(store, load = path => import(/* @vite-ignore */ path)) {
  const [{getBreakthroughMigrationStage}, {physicalStatistics}, {forgedStats}, actions, {getAwakenedPath}, {runDebugTransaction}] = await Promise.all([
    load('/src/util/breakthroughMigration.ts'), load('/src/types/stat.ts'),
    load('/src/data/thresholdEffects/forgedStats.ts'), load('/src/store/slices/breakthroughMigrationActions.ts'),
    load('/src/util/getMeridianEffects.ts'), load('/src/store/debugTransaction.ts'),
  ]);
  const choices=[];
  store.dispatch(runDebugTransaction((dispatch,getState)=>{
    const stage=()=>getBreakthroughMigrationStage(getState().player.player.realm,getState().breakthrough);
    if(stage()==='bodyForging') {
      const stats=[...physicalStatistics].sort((a,b)=>(getState().player.player.physicalStats[b]??0)-(getState().player.player.physicalStats[a]??0));
      for(const stat of stats) {
        if(dispatch(actions.migrateForgedStat(stat)))choices.push({stat,forged:true});
      }
      if(!dispatch(actions.completeBreakthroughMigration()))throw new Error('Preview could not complete Body Forging migration');
    }
    if(stage()==='meridianOpening') {
      for(const stat of physicalStatistics) {
        const state=getState();
        if(!state.breakthrough.bodyForging?.forging?.forgedStats[stat] || getAwakenedPath(state.breakthrough,stat))continue;
        const path=Object.keys(forgedStats[stat].paths)[0];
        if(!path || !dispatch(actions.migrateMeridianAwakening(stat,path)))throw new Error('Preview could not awaken '+stat);
        choices.push({stat,path});
      }
      if(!dispatch(actions.completeBreakthroughMigration()))throw new Error('Preview could not complete Meridian Opening migration');
    }
    if(stage())throw new Error('Preview save still requires breakthrough migration');
  }));
  return choices;
}
