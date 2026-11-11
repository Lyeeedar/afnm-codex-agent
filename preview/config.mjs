import {previewAssetURLs} from './asset-urls.mjs';
import {previewStateTools} from './state-plugin.mjs';
import {deferredPreviewImages} from './deferred-images.mjs';

export async function previewConfig(original,environment,{reactCompiler=process.env.PREVIEW_REACT_COMPILER==='1',bakeCombatArt=process.env.PREVIEW_BAKE_COMBAT_ART==='1'}={}) {
  const config=typeof original==='function'?await original(environment):await original;
  const plugins=(await Promise.all((config.plugins??[]).flat(Infinity))).flat(Infinity);
  // AFNM's Babel plugin contains only the React Compiler preset. Memoization is
  // optional for a visual preview, but compiling the whole game dominates cold
  // startup. Retain React's JSX/Fast Refresh plugins. Opt in for compiler bugs.
  // The game already measures combat geometry on demand when baked data is
  // absent. Avoid decoding every actor and VFX sheet just to reach the menu.
  const previewPlugins=plugins.filter(plugin=>plugin && typeof plugin.name==='string' && !plugin.name.includes('electron') && (reactCompiler || !['@rolldown/plugin-babel','vite:react-compiler'].includes(plugin.name)) && (bakeCombatArt || plugin.name!=='bake-combat-art-bounds'));
  // The checkout also contains dashboards and tools with their own HTML entries.
  // Scan the game alone unless the project explicitly supplies optimizer entries.
  const optimizeDeps={entries:['index.html'],...config.optimizeDeps};
  // Retain the game's watcher exclusions rather than watching the whole checkout.
  // Vite otherwise recursively transforms the whole graph behind our bounded
  // HTTP queue, retaining thousands of concurrent transforms on small runners.
  const server={...config.server,host:'127.0.0.1',port:4173,strictPort:true,preTransformRequests:false};
  const environments={...config.environments,client:{...config.environments?.client,dev:{...config.environments?.client?.dev,preTransformRequests:false}}};
  return {...config,optimizeDeps,environments,plugins:[previewStateTools(),...previewPlugins,deferredPreviewImages(config.root),previewAssetURLs(config.root)],server};
}
