import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectScreenshots,publishScreenshotImages} from '../src/evidence.mjs';
import {render,githubScreenshotLinks} from '../src/core.mjs';
test('visual artifacts contain only PNG files and never follow symlinks or include saves',async()=>{
  const root=await mkdtemp(join(tmpdir(),'evidence-'));
  try {
    const source=join(root,'source'),destination=join(root,'artifact');await mkdir(source);
    await writeFile(join(source,'actual.png'),Buffer.from([137,80,78,71,13,10,26,10,1,2]));
    await writeFile(join(source,'save.json'),'private save');await writeFile(join(source,'fake.png'),'not PNG');
    await symlink(join(source,'actual.png'),join(source,'linked.png'));
    assert.equal(await collectScreenshots(source,destination),1);
    assert.deepEqual(await readdir(destination),['actual.png']);
    const body=render('',{version:1,issue:7},{phase:'done',started:Date.now(),runUrl:'https://github.com/run',screenshots:1});
    assert.match(body,/\[Screenshots \(1\)\]\(https:\/\/github.com\/run#artifacts\)/);
  } finally {await rm(root,{recursive:true});}
});

test('GitHub reports replace container screenshot images with artifact links, preserving external images',()=>{
 const run='https://github.com/org/repo/actions/runs/42';
 const text='![Selected](/agent-output/selected.png)\n[Custom](sandbox:/agent-output/custom.png)\n![Other](/workspace/results/other.png)\n![Public](https://example.com/image.png)';
 const result=githubScreenshotLinks(text,run);
 assert.doesNotMatch(result,/agent-output|sandbox:|\/workspace/);
 assert.match(result,/\[Selected — selected.png \(screenshot artifact\)\]\(https:\/\/github.com\/org\/repo\/actions\/runs\/42#artifacts\)/);
 assert.ok(result.includes('![Public](https://example.com/image.png)'));
 const body=render('',{version:1,issue:1},{phase:'done',started:0,message:text,runUrl:run},0);
 assert.doesNotMatch(body,/!\[Selected\]/);assert.match(body,/selected.png/);
});

test('inline screenshots publish PNGs on an independent public-repository evidence branch',async()=>{
 const root=await mkdtemp(join(tmpdir(),'inline-evidence-'));const calls=[];
 const api={json:async(path,options)=>{calls.push({path,...options});if(path.endsWith('/blobs'))return {sha:'blob'};if(path.endsWith('/trees'))return {sha:'tree'};if(path.endsWith('/commits'))return {sha:'commit'};return {};}};
 try{
  await writeFile(join(root,'result.png'),Buffer.from([137,80,78,71,13,10,26,10,1]));await writeFile(join(root,'private-save.json'),'private');
  const images=await publishScreenshotImages(root,{api,repository:'org/public',prNumber:7,runId:'99',attempt:'1'});
  assert.deepEqual(images,{'result.png':'https://raw.githubusercontent.com/org/public/commit/images/result.png'});
  assert.deepEqual(calls.find(call=>call.path.endsWith('/commits')).body.parents,[]);
  assert.equal(calls.find(call=>call.path.endsWith('/refs')).body.ref,'refs/heads/codex-evidence/pr-7/run-99-1');
  assert.equal(calls.filter(call=>call.path.endsWith('/blobs')).length,1);
  const body=render('',{version:1,issue:7},{phase:'done',started:0,runUrl:'https://github.com/run',message:'Changed result.png',screenshotImages:images},0);
  assert.match(body,/!\[result.png\]\(https:\/\/raw\.githubusercontent\.com\/org\/public\/commit\/images\/result.png\)/);
  const embedded=githubScreenshotLinks('![Result](/agent-output/result.png)','https://github.com/run',images);
  assert.equal(embedded,'![Result](https://raw.githubusercontent.com/org/public/commit/images/result.png)');
 }finally{await rm(root,{recursive:true});}
});
test('a failed inline upload does not produce an image URL or publish a branch',async()=>{
 const root=await mkdtemp(join(tmpdir(),'inline-failure-'));let calls=0;
 try{await writeFile(join(root,'result.png'),Buffer.from([137,80,78,71,13,10,26,10,1]));
  await assert.rejects(publishScreenshotImages(root,{api:{json:async()=>{calls++;throw new Error('upload denied');}},repository:'org/public',prNumber:7,runId:'99',attempt:'1'}),/upload denied/);assert.equal(calls,1);
 }finally{await rm(root,{recursive:true});}
});
