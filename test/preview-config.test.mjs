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
  assert.deepEqual(config.plugins.map(plugin=>plugin.name),['agent-preview-state','react-compiler','preview-direct-asset-urls']);
  assert.deepEqual(config.server,{host:'127.0.0.1',port:4173,strictPort:true});
});
