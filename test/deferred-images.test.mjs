import test from 'node:test';
import assert from 'node:assert/strict';
import {deferredPreviewImages} from '../preview/deferred-images.mjs';

function setup(result={code:'export default "/@imagetools/resized.webp";'}) {
  const plugin=deferredPreviewImages('/workspace');let middleware;const calls=[];
  plugin.configureServer({middlewares:{use:fn=>{middleware=fn;}},transformRequest:async source=>{calls.push(source);if(result instanceof Error)throw result;return result;}});
  const request=async url=>{
    const response={statusCode:200,headers:{},setHeader(key,value){this.headers[key]=value;},end(body){this.body=body;}};
    let next=false;await middleware({url},response,()=>{next=true;});return {...response,next};
  };
  return {plugin,calls,request};
}
test('eager glob and ordinary thumbnail imports defer resizing until image requests',async()=>{
  const {plugin,calls,request}=setup();
  const source=`import { default as __vite_glob_0_0 } from "../../assets/npc/actor.png?w=384&h=384&fit=inside";
import small from '../../assets/npc/actor.png?w=128&h=128&fit=inside';`;
  const result=plugin.transform(source,'/workspace/src/screens/worldMap/mapSpriteImages.ts');
  assert.doesNotMatch(result.code,/\bimport\b/);
  const urls=[...result.code.matchAll(/"(\/@agent-image\/[a-f0-9]+)"/g)].map(match=>match[1]);
  assert.equal(urls.length,2);assert.notEqual(urls[0],urls[1]);assert.deepEqual(calls,[]);
  const response=await request(urls[0]);
  assert.equal(response.statusCode,302);assert.equal(response.headers.Location,'/@imagetools/resized.webp');
  assert.equal(calls.length,1);assert.match(calls[0],/actor.png\?w=384&h=384&fit=inside$/);
});
test('unrelated imports, SVG components, metadata and multi-size outputs retain their semantics',()=>{
  const {plugin}=setup();
  for(const source of ['image.png','image.svg?react','image.png?w=128;384','image.png?w=128&as=metadata','image.png?url','image.png?w=128&as=srcset']) {
    assert.equal(plugin.transform(`import value from './${source}';`,'/workspace/src/image.ts'),null);
  }
  assert.equal(plugin.transform('import image from "./image.png?w=128";','/workspace/image.css'),null);
});
test('deferred image errors are explicit and arbitrary sources cannot be requested',async()=>{
  const {plugin,calls,request}=setup(new Error('Image resize failed'));
  assert.equal((await request('/unrelated')).next,true);
  assert.equal((await request('/@agent-image/unknown')).statusCode,404);assert.equal(calls.length,0);
  const result=plugin.transform('import image from "./image.png?w=128";','/workspace/src/image.ts');
  const url=result.code.match(/"([^\"]+)"/)[1];
  const response=await request(url);assert.equal(response.statusCode,500);assert.equal(response.body,'Image resize failed');
});
test('unexpected imagetools output cannot become an external redirect',async()=>{
  const {plugin,request}=setup({code:'export default "https://example.com/";'});
  const result=plugin.transform('import image from "./image.png?w=128";','/workspace/src/image.ts');
  const response=await request(result.code.match(/"([^\"]+)"/)[1]);
  assert.equal(response.statusCode,500);assert.equal(response.headers.Location,undefined);
});
