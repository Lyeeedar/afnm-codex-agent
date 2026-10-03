import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectScreenshots} from '../src/evidence.mjs';
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
