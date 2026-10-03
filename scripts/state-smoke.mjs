import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
const exec=promisify(execFile),metrics={};
const invoke=async args=>JSON.parse((await exec('node',['/opt/agent-preview/control.mjs',...args],{maxBuffer:8*1024*1024,timeout:180000})).stdout).result;
const phase=async(name,operation)=>{const start=performance.now();try{return await operation();}finally{metrics[name+'Seconds']=Number(((performance.now()-start)/1000).toFixed(2));await writeFile('/agent-output/state-timings.json',JSON.stringify(metrics,null,2));console.log(name+': '+metrics[name+'Seconds']+' seconds');}};
const apply=async spec=>{await writeFile('/workspace/.agent-preview/scenario.json',JSON.stringify(spec));return invoke(['state','apply','/workspace/.agent-preview/scenario.json']);};
try {
  await phase('startup',()=>exec('node',['/opt/agent-preview/start.mjs'],{maxBuffer:4*1024*1024,timeout:480000}));
  metrics.setup=await phase('freshCoreLibrary',()=>apply({base:'fresh',realm:'coreFormation',screen:'library',money:100000}));
  if(metrics.setup.screen!=='library'||metrics.setup.realm!=='coreFormation')throw new Error('Core library was not selected');
  await invoke(['screenshot','state-library.png']);
  metrics.checkpoint=await phase('snapshot',()=>invoke(['state','snapshot','core-library']));
  metrics.map=await phase('jumpToMap',()=>apply({base:'current',screen:'map'}));
  if(metrics.map.screen!=='map')throw new Error('Map jump failed');
  await invoke(['screenshot','state-map.png']);
  metrics.restored=await phase('restore',()=>invoke(['state','restore',metrics.checkpoint.path]));
  if(metrics.restored.screen!=='library')throw new Error('Checkpoint restoration failed');
  metrics.inspected=await invoke(['state','inspect','inventory.money,player.player.realm']);
  if(metrics.inspected.values['inventory.money']!==100000)throw new Error('Checkpoint money was not preserved');
  let rejected=false;try{await apply({base:'current',screen:'combat',money:1});}catch{rejected=true;}
  if(!rejected)throw new Error('Incomplete combat state should fail');
  if((await invoke(['state','inspect','inventory.money'])).values['inventory.money']!==100000)throw new Error('Failed setup mutated the report');
  metrics.enemyCatalog=await invoke(['state','catalog','enemies','']);
  const enemy=metrics.enemyCatalog.matches.find(x=>x.realm==='bodyForging');
  if(!enemy)throw new Error('No body-forging enemy discovered');
  metrics.combat=await phase('startCombat',()=>apply({base:'fresh',realm:'bodyForging',combat:{enemy:enemy.name}}));
  if(metrics.combat.screen!=='combat')throw new Error('Combat initializer failed');
  await invoke(['screenshot','state-combat.png']);
  const recipes=await invoke(['state','catalog','recipes','Healing']);
  const recipe=recipes.matches.find(x=>x.realm==='bodyForging');
  if(!recipe)throw new Error('No body-forging healing recipe discovered');
  metrics.crafting=await phase('startCrafting',()=>apply({base:'fresh',realm:'bodyForging',crafting:{recipe:recipe.name}}));
  if(metrics.crafting.screen!=='crafting')throw new Error('Crafting initializer failed');
  await invoke(['screenshot','state-crafting.png']);
  metrics.finalPage=await invoke(['inspect']);
  if(/something went wrong|unexpected error/i.test(metrics.finalPage.text))throw new Error('Renderer error screen');
  metrics.passed=true;
}catch(error){metrics.error=error.message;metrics.passed=false;try{metrics.page=await invoke(['inspect']);await invoke(['screenshot','state-failure.png']);}catch{};process.exitCode=1;}
finally {await writeFile('/agent-output/state-timings.json',JSON.stringify(metrics,null,2));await writeFile('/agent-output/state-preview.log',await readFile('/workspace/.agent-preview/preview.log','utf8').catch(()=>''));console.log(JSON.stringify(metrics,null,2));}

