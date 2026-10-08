import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {translationSourceIssues,completeTranslationSources} from '../src/translation-sources.mjs';
const exec=promisify(execFile);
const generated='src/translations/ru.json',raw='translation-pipeline/raw/ru.json';
const entry=value=>({locations:{Sect:{'[title] Registry':value}}});

async function fixture(operation) {
  const workspace=await mkdtemp(join(tmpdir(),'translation-source-'));
  const git=async(...args)=>(await exec('git',args,{cwd:workspace})).stdout.trim();
  const write=async(path,value)=>{await mkdir(dirname(join(workspace,path)),{recursive:true});await writeFile(join(workspace,path),typeof value==='string'?value:JSON.stringify(value));};
  try {
    await git('init');await git('config','user.name','Test');await git('config','user.email','test@example.com');
    await write(generated,entry('old'));await write(raw,{Registry:'old'});
    await git('add','-A');await git('commit','-m','baseline');
    const baseline=await git('rev-parse','HEAD');
    const inspect=()=>translationSourceIssues({workspace,git,baseline});
    await operation({write,git,inspect});
  }finally{await rm(workspace,{recursive:true,force:true});}
}

test('generated-only edits and formatting-only raw edits both require an actual raw source change',()=>fixture(async({write,inspect})=>{
  await write(generated,entry('fixed'));
  assert.deepEqual(await inspect(),[{generated,raw}]);
  await write(raw,'{\n  "Registry": "old"\n}\n');
  assert.deepEqual(await inspect(),[{generated,raw}]);
  await write(raw,{Registry:'fixed'});
  assert.deepEqual(await inspect(),[]);
}));

test('the full PR, including agent commits and untracked language files, is checked per language',()=>fixture(async({write,git,inspect})=>{
  await write(generated,entry('fixed'));await write(raw,{Registry:'fixed'});
  await git('add','-A');await git('commit','-m','fix Russian');
  await write('src/translations/zh-CN.json',entry('Chinese'));
  assert.deepEqual(await inspect(),[{generated:'src/translations/zh-CN.json',raw:'translation-pipeline/raw/zh-CN.json'}]);
  await write('translation-pipeline/raw/zh-CN.json',{Registry:'Chinese'});
  assert.deepEqual(await inspect(),[]);
}));

test('generated formatting, removed fields, empty new fields and source templates need no raw edits',()=>fixture(async({write,inspect})=>{
  await write(generated,JSON.stringify(entry('old'),null,2)+'\n');
  await write('src/translations/template.json',entry('English'));
  await write('src/translations/custom-strings.json',entry('Custom'));
  assert.deepEqual(await inspect(),[]);
  await write(generated,{locations:{Sect:{'[title] New':'','[empty] Blank':''}}});
  assert.deepEqual(await inspect(),[]);
}));

test('clearing an existing translation still requires its raw source update',()=>fixture(async({write,inspect})=>{
  await write(generated,entry(''));
  assert.deepEqual(await inspect(),[{generated,raw}]);
}));

test('same-session repair automatically fixes missing raw sources without repeating the original task',()=>fixture(async({write,inspect})=>{
  const turns=[],reports=[];
  await completeTranslationSources({prompt:'Fix the label',inspect,report:async text=>reports.push(text),runTurn:async(text,correction)=>{
    turns.push({text,correction});
    if(!correction)await write(generated,entry('fixed'));
    else await write(raw,{Registry:'fixed'});
  }});
  assert.deepEqual(turns.map(turn=>turn.correction),[0,1]);
  assert.match(turns[1].text,/translation-pipeline\/raw\/ru.json/);
  assert.match(turns[1].text,/Preserve completed work/);
  assert.equal(reports.length,1);assert.deepEqual(await inspect(),[]);
}));

test('persistent generated-only changes stop after two repair turns instead of returning success',async()=>{
  const turns=[];
  await assert.rejects(completeTranslationSources({prompt:'task',inspect:async()=>[{generated,raw}],runTurn:async(text,correction)=>turns.push(correction)}),/after 2 automatic repair turns/);
  assert.deepEqual(turns,[0,1,2]);
});

test('already complete changes need no repair turn',async()=>{
  const turns=[];
  await completeTranslationSources({prompt:'task',inspect:async()=>[],runTurn:async(text,correction)=>turns.push(correction)});
  assert.deepEqual(turns,[0]);
});

test('source inspection failures surface without prompting the agent to fabricate a source change',async()=>{
  let turns=0;
  await assert.rejects(completeTranslationSources({prompt:'task',inspect:async()=>{throw new Error('invalid JSON');},runTurn:async()=>{turns++;}}),/invalid JSON/);
  assert.equal(turns,1);
});
