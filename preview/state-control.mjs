import * as fs from 'node:fs/promises';
import {resolve} from 'node:path';
export async function stateCommand(page,body,{workspace='/workspace'}={}) {
  const {operation='inspect',argument,query=''}=body;
  const invoke=(method,value)=>page.evaluate(async({method,value})=>{
    const {createStateTools}=await import('/@agent-state');
    if(!window.gameStore)throw new Error('Game store is not ready');
    const tools=createStateTools({store:window.gameStore});
    return tools[method](value);
  },{method,value});
  if(operation==='inspect')return invoke('inspect',argument?.split(',') ?? []);
  if(operation==='catalog')return page.evaluate(async({kind,query})=>{
    const {createStateTools}=await import('/@agent-state');
    return createStateTools({store:window.gameStore}).catalog(kind,query);
  },{kind:argument,query});
  if(operation==='snapshot') {
    if(!/^[\w.-]+$/.test(argument ?? ''))throw new Error('Snapshot needs a plain name');
    const directory=workspace+'/.agent-preview/checkpoints';
    await fs.mkdir(directory,{recursive:true});
    const path=directory+'/'+argument+'.json';
    await fs.writeFile(path,JSON.stringify(await invoke('snapshot')));
    return {path,...await invoke('inspect')};
  }
  if(!['apply','restore'].includes(operation))throw new Error('State command must be inspect, catalog, apply, snapshot or restore');
  if(!argument)throw new Error(operation+' requires a JSON file path');
  const path=resolve(workspace,argument);
  if(!(path.startsWith(workspace+'/') || path.startsWith('/agent-input/')))throw new Error('State JSON must be in the workspace or /agent-input');
  if((await fs.stat(path)).size>32*1024*1024)throw new Error('State JSON exceeds 32 MiB');
  const value=JSON.parse(await fs.readFile(path,'utf8'));
  const active=await page.evaluate(()=>!!window.hasRedux);
  const before=await invoke('snapshot');
  let committed=false;
  try {
    const result=await invoke(operation,value);
    committed=true;
    if(!active) {
      // The preview-only adapter exposes SaveRouter's normal loader, avoiding a
      // renderer reload or an interactive trip through the character wizard.
      await page.evaluate(()=>{
        if(!window.__agentPreview?.loadSave)throw new Error('Preview SaveRouter adapter is not attached');
        window.__agentPreview.setSave('agent-preview-scenario',JSON.stringify(window.gameStore.getState()));
        window.__agentPreview.loadSave('agent-preview-scenario');
      });
      await page.waitForFunction(()=>window.hasRedux===true,undefined,{timeout:60000});
    }
    // Wait for React and the router's transition, then check the selected screen
    // again. A triggered event must not be mistaken for the requested destination.
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.waitForTimeout(600);
    await page.waitForFunction(()=>{
      const text=document.body.innerText.trim();
      if(/A Fatal Error has occurred|The game has attempted to recover, but has failed/i.test(text))throw new Error('The renderer entered its error screen during state setup');
      return text.replace(/\s/g,'')!=='Loading...' && text.length>40;
    },undefined,{timeout:30000});
    const current=await invoke('inspect');
    if(current.screen!==result.screen)throw new Error('Setup selected '+result.screen+' but the game moved to '+current.screen+'; inspect triggers/prerequisites');
    return {...current,activeSave:true};
  }catch(error){
    if(active && committed)await invoke('restore',before).catch(()=>{});
    throw error;
  }
}
