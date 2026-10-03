import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectScreenshots} from '../src/evidence.mjs';
import {render} from '../src/core.mjs';
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
