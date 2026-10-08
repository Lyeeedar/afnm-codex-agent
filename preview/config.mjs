import {previewAssetURLs} from './asset-urls.mjs';
import {previewStateTools} from './state-plugin.mjs';

export async function previewConfig(original,environment) {
  const config=typeof original==='function'?await original(environment):await original;
  const plugins=(await Promise.all((config.plugins??[]).flat(Infinity))).flat(Infinity);
  // Both the adapter and React compiler are pre plugins. The adapter must see
  // source hooks and JSX before the compiler rewrites them into cached callbacks.
  return {...config,plugins:[previewStateTools(),...plugins.filter(plugin=>plugin && typeof plugin.name==='string' && !plugin.name.includes('electron')),previewAssetURLs()],server:{host:'127.0.0.1',port:4173,strictPort:true}};
}
