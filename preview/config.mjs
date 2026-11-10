import {previewAssetURLs} from './asset-urls.mjs';
import {previewStateTools} from './state-plugin.mjs';
import {deferredPreviewImages} from './deferred-images.mjs';

export async function previewConfig(original,environment) {
  const config=typeof original==='function'?await original(environment):await original;
  const plugins=(await Promise.all((config.plugins??[]).flat(Infinity))).flat(Infinity);
  // Both the adapter and React compiler are pre plugins. The adapter must see
  // source hooks and JSX before the compiler rewrites them into cached callbacks.
  // The checkout also contains dashboards and tools with their own HTML entries.
  // Scan the game alone unless the project explicitly supplies optimizer entries.
  const optimizeDeps={entries:['index.html'],...config.optimizeDeps};
  // Retain the game's watcher exclusions rather than watching the whole checkout.
  const server={...config.server,host:'127.0.0.1',port:4173,strictPort:true};
  return {...config,optimizeDeps,plugins:[previewStateTools(),...plugins.filter(plugin=>plugin && typeof plugin.name==='string' && !plugin.name.includes('electron')),deferredPreviewImages(config.root),previewAssetURLs()],server};
}
