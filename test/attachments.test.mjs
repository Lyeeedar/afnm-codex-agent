import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {attachmentLinks,downloadAttachments} from '../src/attachments.mjs';
import {API} from '../src/api.mjs';

test('extracts and deduplicates raw/blob attachments, rejecting lookalike hosts and malformed paths',()=>{
  const links=attachmentLinks('[save](https://github.com/org/private/blob/report-saves/save%20file.json) https://raw.githubusercontent.com/org/private/report-saves/save%20file.json https://raw.githubusercontent.com/org/assets/report-assets/picture.webp https://github.com.evil/org/private/blob/main/save.json https://github.com/org/private/issues/1 https://github.com/org/private/blob/main/%zz.json');
  assert.equal(links.length,2);assert.equal(links[0].path,'save file.json');assert.equal(links[1].repo,'org/assets');
});

test('private binary attachments download through authenticated canonical API and expose local paths only',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'attachments-'));
  const bytes=Buffer.from([0,255,1,42]);const requests=[];
  try {
    const api=new API('https://api.github.com','private-token',{},async(url,options)=>{
      requests.push({url,options});assert.equal(options.redirect,'error');
      assert.equal(options.headers.authorization,'Bearer private-token');
      assert.equal(options.headers.Accept,'application/vnd.github.raw+json');
      return new Response(bytes);
    });
    const manifest=await downloadAttachments('https://raw.githubusercontent.com/org/private/report-assets/screenshot.webp',{directory,getAPI:async repo=>{assert.equal(repo,'org/private');return api;}});
    assert.equal(requests[0].url,'https://api.github.com/repos/org/private/contents/screenshot.webp?ref=report-assets');
    assert.deepEqual(await readFile(join(directory,manifest[0].localPath.split('/').pop())),bytes);
    assert.match(manifest[0].localPath,/^\/agent-input\/[\w.-]+$/);
    assert.ok(!(await readFile(join(directory,'manifest.json'),'utf8')).includes('private-token'));
  } finally {await rm(directory,{recursive:true});}
});

test('attachment failures stop before agent execution and oversized streams leave no partial file',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'attachments-'));
  try {
    await assert.rejects(downloadAttachments('https://github.com/org/private/blob/main/save.json',{directory,getAPI:async()=>({request:async()=>new Response('oversized') }),maxBytes:3}),/exceeds/);
    assert.deepEqual(await readdir(directory),[]);
    await assert.rejects(downloadAttachments('https://github.com/org/private/blob/main/save.json',{directory,getAPI:async()=>{throw new Error('missing Contents read permission');}}),/Contents read/);
  } finally {await rm(directory,{recursive:true});}
});
