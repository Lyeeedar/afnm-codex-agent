import test from 'node:test';
import assert from 'node:assert/strict';
import {previewConfig} from '../preview/config.mjs';

test('state adapters run before pre compilers, retaining the automatic trigger guard',async()=>{
  const compiler={name:'react-compiler',enforce:'pre',transform:code=>code.replace('useErrorHandlingEffect(() => {','const callback = () => {')};
  const original=async()=>({define:{GAME:true},plugins:[Promise.resolve([compiler,{name:'electron-main'}]),false]});
  const config=await previewConfig(original,{});
  let code='useErrorHandlingEffect(() => { run(); })';
  for(const plugin of config.plugins.filter(plugin=>plugin.enforce==='pre')) {
    const result=plugin.transform?.(code,'/src/components/game/EventTrigger.tsx');
    code=typeof result==='string'?result:result?.code??code;
  }
  assert.match(code,/const callback = \(\) => \{\s*if \(window.__agentPreview\?\.pauseTriggers\) return;/);
  assert.deepEqual(config.define,{GAME:true});
  assert.deepEqual(config.plugins.map(plugin=>plugin.name),['agent-preview-state','react-compiler','preview-deferred-images','preview-direct-asset-urls']);
  assert.deepEqual(config.server,{host:'127.0.0.1',port:4173,strictPort:true,preTransformRequests:false});
});

test('visual previews omit React Compiler optimization while retaining JSX and Fast Refresh',async()=>{
  const plugins=['vite:react-babel','vite:react-refresh','@rolldown/plugin-babel','vite:react-compiler','vite:svgr'].map(name=>({name}));
  const original={plugins};
  const normal=await previewConfig(original,{}, {reactCompiler:false});
  const names=normal.plugins.map(plugin=>plugin.name);
  assert.ok(names.includes('vite:react-babel'));assert.ok(names.includes('vite:react-refresh'));assert.ok(names.includes('vite:svgr'));
  assert.ok(!names.includes('@rolldown/plugin-babel'));assert.ok(!names.includes('vite:react-compiler'));
  const debugging=await previewConfig(original,{}, {reactCompiler:true});
  assert.ok(debugging.plugins.includes(plugins[2]));assert.ok(debugging.plugins.includes(plugins[3]));
  assert.equal(original.plugins.length,5);
});

test('visual previews defer combat art measurement to the existing runtime fallback',async()=>{
  const bake={name:'bake-combat-art-bounds'},art={name:'imagetools'},textures={name:'world-map-gpu-textures'};
  const original={plugins:[bake,art,textures]};
  const normal=await previewConfig(original,{}, {bakeCombatArt:false});
  assert.ok(!normal.plugins.includes(bake));assert.ok(normal.plugins.includes(art));assert.ok(normal.plugins.includes(textures));
  const baking=await previewConfig(original,{}, {bakeCombatArt:true});assert.ok(baking.plugins.includes(bake));
  assert.equal(original.plugins.length,3);
});

test('preview prevents recursive pretransforms in both Vite configuration APIs without dropping other environment settings',async()=>{
  const original={server:{preTransformRequests:true},environments:{client:{resolve:{conditions:['browser']},dev:{preTransformRequests:true,custom:true}},ssr:{dev:{preTransformRequests:true}}}};
  const config=await previewConfig(original,{});
  assert.equal(config.server.preTransformRequests,false);
  assert.deepEqual(config.environments.client.dev,{preTransformRequests:false,custom:true});
  assert.deepEqual(config.environments.client.resolve,{conditions:['browser']});
  assert.deepEqual(config.environments.ssr,original.environments.ssr);
  assert.equal(original.environments.client.dev.preTransformRequests,true);
});

test('preview retains watcher exclusions and server policies while binding its fixed endpoint',async()=>{
  const ignored=path=>path.includes('/translation-dashboard/');
  const original={server:{host:'0.0.0.0',port:5173,strictPort:false,watch:{ignored},fs:{strict:true},hmr:{overlay:false}}};
  const config=await previewConfig(original,{});
  assert.equal(config.server.watch.ignored,ignored);
  assert.equal(config.server.watch.ignored('/workspace/translation-dashboard/src/main.tsx'),true);
  assert.equal(config.server.watch.ignored('/workspace/src/main.tsx'),false);
  assert.deepEqual(config.server.fs,{strict:true});
  assert.deepEqual(config.server.hmr,{overlay:false});
  assert.equal(config.server.host,'127.0.0.1');
  assert.equal(config.server.port,4173);
  assert.equal(config.server.strictPort,true);
  assert.equal(original.server.port,5173);
});

test('preview limits default dependency discovery to the game without dropping optimizer settings',async()=>{
  const config=await previewConfig({optimizeDeps:{include:['react'],exclude:['native-package']}},{});
  assert.deepEqual(config.optimizeDeps,{entries:['index.html'],include:['react'],exclude:['native-package']});
  const explicit=await previewConfig({server:{watch:null},optimizeDeps:{entries:['custom.html']}},{});
  assert.deepEqual(explicit.optimizeDeps.entries,['custom.html']);
  assert.equal(explicit.server.watch,null);
});
