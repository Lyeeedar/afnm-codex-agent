// Loaded only by the isolated preview's Vite plugin. All setup runs through the
// game's reducers/thunks in a transaction, so failed setup never commits half a state.
const screens = ['location','recipe','mission','manual','cultivation','map','healer','market','favour','vault','herbField','mine','recipeLibrary','requestBoard','compendium','library','altar','research','reforge','expedition','pillarGrid','fallenStar','trainingGround','sectRegistry','tenThousandFlames','lifeScreen','soulShardDelve','enchantmentShop','challengeBoard','formationPuzzle','rumours','newgame','combat','crafting','dualCultivation','event','auction','mysticalRegion','tournament','house','guild','stoneCutting'];
const registries = {
  locations: ['/src/data/locations/locations.ts','locations'],
  items: ['/src/data/items/items.ts','items'],
  recipes: ['/src/data/items/recipes/recipes.ts','recipes'],
  enemies: ['/src/data/monsters/monsters.ts','monsters'],
  techniques: ['/src/data/techniques/techniques.ts','techniques'],
  realms: ['/src/types/realm.ts','realms'],
};
const activitySlices = ['gameEvent','combat','crafting','auction','tournament','dualCultivation','stoneCutting','formationPuzzle','guild','soulShardDelve','mysticalRegion','expedition'];
const clone = value => structuredClone(value);
const safeKey = key => !['__proto__','prototype','constructor'].includes(key);
export function patchState(state, patches) {
  for (const [path,value] of Object.entries(patches)) {
    const keys = path.split('.');
    if (!keys.every(key => key && safeKey(key))) throw new Error('Unsafe state path: '+path);
    let target = state;
    for (const key of keys.slice(0,-1)) {
      if (!Object.hasOwn(target,key) || !target[key] || typeof target[key] !== 'object') throw new Error('Unknown state path: '+path);
      target = target[key];
    }
    target[keys.at(-1)] = clone(value);
  }
  return state;
}

export function createStateTools({store,load = path => import(/* @vite-ignore */ path)}) {
  const module = async path => {
    if (!/^\/src\/[\w/-]+\.(?:ts|tsx|js|mjs)$/.test(path)) throw new Error('Game module must be an absolute /src/ path');
    return load(path);
  };
  const inspect = async (paths=[]) => {
    const state = store.getState();
    const {determineCurrentScreen} = await module('/src/util/determineCurrentScreen.ts');
    const values = {};
    for (const path of paths) {
      if (!path.split('.').every(safeKey)) throw new Error('Unsafe state path');
      values[path] = path.split('.').reduce((value,key) => value?.[key],state) ?? null;
    }
    return {screen:determineCurrentScreen(state),requestedScreen:state.screen.screen,realm:state.player.player.realm,location:state.location.current,characterCreated:state.newGame.characterCreated,values};
  };
  const catalog = async (kind,query='') => {
    if (kind === 'screens') return {total:screens.length,matches:screens.filter(name=>name.toLowerCase().includes(query.toLowerCase()))};
    if (!registries[kind]) throw new Error('Catalog kind must be screens, realms, locations, items, recipes, enemies or techniques');
    const [path,key] = registries[kind];
    const entries = (await module(path))[key];
    const matches = entries.map(value=>typeof value==='string'?{name:value}:{name:value.name,realm:value.realm,kind:value.kind}).filter(value=>value.name.toLowerCase().includes(query.toLowerCase()));
    return {total:entries.length,matched:matches.length,matches:matches.slice(0,50)};
  };
  const restore = async state => {
    if (!state?.player?.player || !state.newGame || !state.location || !state.screen) throw new Error('Expected a game state/save JSON, not a scenario');
    const {runDebugTransaction} = await module('/src/store/debugTransaction.ts');
    store.dispatch(runDebugTransaction(dispatch=>dispatch({type:'RESTORE_STATE',payload:clone(state)})));
    return inspect();
  };
  const apply = async (spec={}) => {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('Scenario must be an object');
    const allowed = ['base','realm','location','screen','flags','items','money','clearActivities','patch','operations','combat','crafting','event'];
    for (const key of Object.keys(spec)) if (!allowed.includes(key)) throw new Error('Unknown scenario field: '+key);
    if (spec.base && !['fresh','current'].includes(spec.base)) throw new Error('base must be fresh or current');
    if (spec.screen && !screens.includes(spec.screen)) throw new Error('Unknown screen: '+spec.screen);
    if ([spec.combat,spec.crafting,spec.event].filter(Boolean).length>1) throw new Error('Choose one active scenario: combat, crafting or event');
    const [{rootReducer},{runDebugTransaction},{commitDebugState},{determineCurrentScreen},playerActions,inventoryActions,locationActions,screenActions] = await Promise.all([
      module('/src/store/index.ts'),module('/src/store/debugTransaction.ts'),module('/src/store/debugState.ts'),module('/src/util/determineCurrentScreen.ts'),module('/src/store/slices/playerSlice.ts'),module('/src/store/slices/inventorySlice.ts'),module('/src/store/slices/locationSlice.ts'),module('/src/store/slices/screenSlice.ts'),
    ]);
    const initial = rootReducer(undefined,{type:'@@INIT'});
    const fresh = spec.base === 'fresh' || (!spec.base && !store.getState().newGame.characterCreated);
    const realm = spec.realm ?? (fresh?'bodyForging':undefined);
    const realmSkip = realm ? await module('/src/components/game/debugRealmSkip.ts') : null;
    const starting = fresh ? await Promise.all([module('/src/data/techniques/none/newGame.ts'),module('/src/data/crafting/newGameActions.ts'),module('/src/util/newGamePointBuy.ts'),module('/src/store/slices/sectSlice.ts')]) : null;
    const flagsActions = spec.flags ? await module('/src/store/slices/gameDataSlice.ts') : null;
    const allItems = spec.items ? (await module('/src/data/items/items.ts')).itemMap : null;
    const locations = spec.location ? (await module('/src/data/locations/locations.ts')).locationMap : null;
    if (spec.location && !locations[spec.location]) throw new Error('Unknown location: '+spec.location+'; use state catalog locations');
    for (const item of spec.items ?? []) {
      if (!allItems[item.name]) throw new Error('Unknown item: '+item.name+'; use state catalog items');
      if (item.stacks !== undefined && (!Number.isInteger(item.stacks) || item.stacks<1)) throw new Error('Item stacks must be a positive integer');
    }
    for (const [flag,value] of Object.entries(spec.flags ?? {})) if (!safeKey(flag) || !Number.isFinite(value)) throw new Error('Flags must have finite numeric values');
    if (spec.money !== undefined && !Number.isFinite(spec.money)) throw new Error('Money must be finite');
    const operations = await Promise.all((spec.operations ?? []).map(async operation=>{
      const fn = (await module(operation.module))[operation.export];
      if (typeof fn !== 'function') throw new Error('Unknown game action export: '+operation.export);
      return {fn,args:operation.args ?? []};
    }));
    const eventActions = spec.combat || spec.event ? await module('/src/store/slices/event/eventSlice.ts') : null;
    const enemy = spec.combat ? (await module('/src/data/monsters/monsters.ts')).monsters.find(value=>value.name===spec.combat.enemy) : null;
    if (spec.combat && !enemy) throw new Error('Unknown enemy; use state catalog enemies');
    let crafting = null;
    if (spec.crafting) {
      const [recipes,actions,builder,flags] = await Promise.all([module('/src/data/items/recipes/recipes.ts'),module('/src/store/slices/crafting/craftingSlice.ts'),module('/src/util/createPlayerCraftingEntity.ts'),module('/src/util/getFlags.ts')]);
      const recipe = recipes.recipes.find(value=>value.name===spec.crafting.recipe);
      if (!recipe) throw new Error('Unknown recipe; use state catalog recipes');
      crafting = {recipe,actions,builder,flags};
    }
    // No UI or save notifications until every operation and screen check succeeds.
    store.dispatch(runDebugTransaction((dispatch,getState)=>{
      if (fresh) {
        const state = clone(initial);
        const [{qiPunch,qiBlock},{newGameActions},{initialStartingStats},{initializeSectState}] = starting;
        state.newGame = {...state.newGame,characterCreated:true,forename:'Agent',surname:'Preview'};
        state.player.player = {...state.player.player,forename:'Agent',surname:'Preview',imageId:state.newGame.imageId,imageIndex:undefined,realmProgress:'Late',physicalStats:{...initialStartingStats},stances:[{name:qiPunch.name,techniques:[qiPunch.name,qiPunch.name]},{name:qiBlock.name,techniques:[qiBlock.name,qiBlock.name]}],knownTechniques:[{name:qiPunch.name},{name:qiBlock.name}],craftingLoadout:newGameActions.map(value=>value.name),craftingTechniques:newGameActions.map(value=>({technique:value.name}))};
        dispatch(commitDebugState(state));
        dispatch(initializeSectState());
      }
      if (realm && realm !== getState().player.player.realm) {
        if (!realmSkip.debugSkipRealms.includes(realm)) throw new Error('No authored progression preset for '+realm+'. Load a report save/checkpoint, or explicitly patch the state; changing only the realm does not create a valid late-game build.');
        const before = getState().player.player.realm;
        dispatch(realmSkip.skipToRealm(realm));
        if (getState().player.player.realm !== realm) throw new Error('Cannot skip backwards from '+before+'; use base: fresh or restore a checkpoint');
      }
      if (spec.clearActivities === true || (spec.clearActivities !== false && fresh)) {
        const state = clone(getState());
        for (const key of activitySlices) state[key] = clone(initial[key]);
        state.house.inHouse = false;
        dispatch(commitDebugState(state));
      }
      for (const [flag,value] of Object.entries(spec.flags ?? {})) dispatch(flagsActions.setFlag({flag,value}));
      for (const item of spec.items ?? []) dispatch(inventoryActions.addItem({name:item.name,stacks:item.stacks ?? 1}));
      if (spec.money !== undefined) dispatch(inventoryActions.addMoney(spec.money-getState().inventory.money));
      if (spec.patch) dispatch(commitDebugState(patchState(clone(getState()),spec.patch)));
      if (spec.location) dispatch(locationActions.changeCurrentLocation(spec.location));
      if (spec.screen) dispatch(screenActions.navigate(spec.screen));
      for (const {fn,args} of operations) dispatch(fn(...args));
      if (spec.event || spec.combat) {
        const state = getState();
        const gameEvent = spec.event ?? {location:state.location.current,steps:[{kind:'combat',enemies:[enemy],victory:[],defeat:[]}]};
        if (!dispatch(eventActions.startEvent({player:state.player.player,gameEvent}))) throw new Error('Event could not start; clear active activities or satisfy its prerequisites');
      }
      if (crafting) {
        const state = getState();
        const flags = crafting.flags.getFlags(state,{});
        dispatch(crafting.actions.initCrafting({player:crafting.builder.createPlayerCraftingEntity(state.player.player,state.breakthrough,state.characters,undefined,flags),recipe:crafting.recipe,gameFlags:flags}));
      }
      const expected = spec.screen ?? (spec.combat?'combat':spec.crafting?'crafting':undefined);
      const actual = determineCurrentScreen(getState());
      if (expected && actual !== expected) throw new Error('Requested '+expected+' but state selects '+actual+'. Supply its initializer via operations or patch, or restore a matching save.');
    }));
    return inspect();
  };
  return {inspect,catalog,apply,restore,snapshot:()=>clone(store.getState())};
}
