import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {previewAssetURLs} from '../preview/asset-urls.mjs';
import {installPreviewBridge} from '../preview/bridge.mjs';
test('preview asset URLs eliminate module requests while retaining transformed SVG/image imports',async()=>{
  const root=await mkdtemp(join(tmpdir(),'asset-urls-'));
  try {
    await mkdir(join(root,'src'));await writeFile(join(root,'src','image.webp'),'image');await writeFile(join(root,'src','icon.svg'),'svg');
    const source="import image from './image.webp'; import icon from './icon.svg?react'; import resized from './image.webp?w=100'; import dep from 'package';";
    const result=previewAssetURLs(root).transform(source,join(root,'src','page.tsx'));
    assert.match(result.code,/const image="\/@fs/);assert.match(result.code,/import icon from '\.\/icon.svg\?react'/);assert.match(result.code,/import resized from '\.\/image.webp\?w=100'/);assert.match(result.code,/import dep from 'package'/);
    assert.equal(previewAssetURLs(root).transform("import missing from './missing.webp';",join(root,'src','page.tsx')),null);
  }finally {await rm(root,{recursive:true});}
});
test('browser adapter uses isolated temporary saves and can load supplied report JSON',async()=>{
  const previous=global.window;global.window={};
  try {
    const save=JSON.stringify({newGame:{characterCreated:true},player:{player:{forename:'Report'}}});
    installPreviewBridge({version:'0.7.14',saveData:save});
    assert.equal(await window.app.getVersion(),'0.7.14');assert.deepEqual(await window.myFS.listSaves(),[{name:'agent-preview-report'}]);
    assert.equal(await window.myFS.readSave('agent-preview-report'),save);
    await window.myFS.writeSave('temporary','{}');assert.equal(await window.myFS.readSave('temporary'),'{}');
    installPreviewBridge({version:'0.7.14'});assert.deepEqual(await window.myFS.listSaves(),[]);
  }finally {global.window=previous;}
});
