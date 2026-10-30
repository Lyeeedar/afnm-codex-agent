import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {gitOutput} from '../src/git.mjs';
import {translationInstructionsFor,translationSourceIssues,completeTranslationSources} from '../src/translation-sources.mjs';
const generated='src/translations/ru.json',raw='translation-pipeline/raw/ru.json';
const entry=value=>({locations:{Sect:{'[title] Registry':value}}});

async function fixture(operation,{generatedValue=entry('old'),rawValue={Registry:'old'},templateValue}={}) {
  const workspace=await mkdtemp(join(tmpdir(),'translation-source-'));
  const git=async(...args)=>gitOutput(args,{cwd:workspace,maxBuffer:8*1024*1024});
  const write=async(path,value)=>{await mkdir(dirname(join(workspace,path)),{recursive:true});await writeFile(join(workspace,path),typeof value==='string'?value:JSON.stringify(value));};
  try {
    await git('init');await git('config','user.name','Test');await git('config','user.email','test@example.com');
    await write(generated,generatedValue);await write(raw,rawValue);
    if(templateValue)await write('src/translations/template.json',templateValue);
    await git('add','-A');await git('commit','-m','baseline');
    const baseline=await git('rev-parse','HEAD');
    const inspect=()=>translationSourceIssues({workspace,git,baseline});
    await operation({write,git,inspect});
  }finally{await rm(workspace,{recursive:true,force:true});}
}

const metadata='src/translations/metadata.json';
const part='src/translations/0.ru.json';
const catalogue={format:'afnm-translation-metadata',version:2,entries:{locations:{Registry:{english:'Registry',translationContext:'',occurrences:[{category:'locations',objectId:'Sect',fieldKey:'[title] Registry'}]}}}};
const manifest={format:'afnm-translations',version:2,entries:{},parts:['0.ru.json']};

function groupedFixture(operation) {
  return fixture(async context=>{
    const {write,git}=context;
    await git('rm',raw);
    await write(metadata,catalogue);await write(generated,manifest);
    await write(part,{format:'afnm-translations',version:2,entries:{locations:{Registry:'old'}}});
    await git('add','-A');await git('commit','-m','migrate catalogue');
    const baseline=await git('rev-parse','HEAD');
    let verifications=0;
    const verify=async()=>{verifications++;};
    // Recover the workspace through Git, as production does, rather than mocking file reads.
    const workspace=await git('rev-parse','--show-toplevel');
    await operation({...context,workspace,baseline,verify,count:()=>verifications,inspect:options=>translationSourceIssues({workspace,git,baseline,verify,...options})});
  });
}

test('grouped instructions supersede saved raw/generated advice; legacy checkouts retain their workflow',()=>fixture(async({git})=>{
  const workspace=await git('rev-parse','--show-toplevel'),baseline=await git('rev-parse','HEAD');
  assert.match(await translationInstructionsFor({workspace,git,baseline}),/Legacy AFNM/);
}));

test('grouped part-only and new-language edits need verification, never matching raw files',()=>groupedFixture(async({write,inspect,count,workspace,git,baseline})=>{
  const guidance=await translationInstructionsFor({workspace,git,baseline});
  for(const phrase of ['supersede','authoritative targets','find --query','lookup --language','guarded set','check-batch','apply-batch','--after-packet','--acknowledge-compatibility','read-only'])assert.ok(guidance.includes(phrase),phrase);
  assert.doesNotMatch(guidance,/raw\/<language>\.json is the editable source/);
  await write(part,{format:'afnm-translations',version:2,entries:{locations:{Registry:'fixed'}}});
  assert.deepEqual(await inspect(),[]);assert.equal(count(),1);
  await write('src/translations/zh-CN.json',{format:'afnm-translations',version:2,entries:{locations:{Registry:'Chinese'}}});
  assert.deepEqual(await inspect(),[]);assert.equal(count(),2);
}));

test('metadata, deleted parts and archived variants are verified using the checkout reader',()=>groupedFixture(async({write,git,inspect,count})=>{
  await write(metadata,{...catalogue,extra:'context updated'});
  await write('src/translations/archive/0.ru.json',{archived:'variant'});
  await git('rm',part);
  const error=Object.assign(new Error('verify failed'),{stderr:'Missing translation part: 0.ru.json'});
  const issues=await inspect({verify:async()=>{throw error;}});
  assert.equal(issues.length,1);assert.match(issues[0].message,/Missing translation part/);
  assert.equal(count(),0);
  await assert.rejects(inspect({verify:undefined}),/requires the isolated executor/);
}));

test('recreated raw language files are rejected while durable guidance changes are allowed',()=>groupedFixture(async({write,git,inspect,count})=>{
  await write('translation-pipeline/raw/_guidance/ru.json',{instruction:'preserve this'});
  await write('translation-pipeline/raw/review-state/ru.json',{reviewed:true});
  assert.deepEqual(await inspect(),[]);assert.equal(count(),0);
  await write(raw,{Registry:'fixed'});
  assert.match((await inspect())[0].message,/Retired raw language/);
  await git('add',raw);await git('commit','-m','erroneous raw export');
  assert.equal((await inspect())[0].file,raw,'committed duplicate exports are checked too');
}));

test('deleted, malformed and downgraded metadata cannot disable grouped checks',()=>groupedFixture(async({write,git,inspect,workspace,baseline})=>{
  await git('rm',metadata);
  assert.match((await inspect())[0].message,/Restore the valid shared catalogue/);
  assert.match(await translationInstructionsFor({workspace,git,baseline}),/Current AFNM grouped/);
  for(const value of ['{invalid',{},entry('legacy export')]) {
    await write(metadata,value);
    assert.equal((await inspect())[0].file,metadata);
  }
}));

test('unrelated code and unchanged catalogues do not trigger costly catalogue verification',()=>groupedFixture(async({write,inspect,count})=>{
  await write('src/components/Example.ts','export const answer=42;');
  assert.deepEqual(await inspect(),[]);assert.equal(count(),0);
}));

test('grouped repair prompts preserve the new workflow and never demand fabricated raw files',()=>groupedFixture(async({write,inspect,workspace,git,baseline})=>{
  await write(raw,{Registry:'fixed'});
  const turns=[];
  await completeTranslationSources({prompt:'Fix Registry',inspect,instructions:()=>translationInstructionsFor({workspace,git,baseline}),runTurn:async(text,correction)=>{
    turns.push(text);
    if(correction)await rm(join(workspace,raw));
  }});
  assert.equal(turns.length,2);
  assert.match(turns[1],/Current AFNM grouped/);
  assert.doesNotMatch(turns[1],/needs a corresponding update|raw sources|is the editable source/);
}));

test('source checks read generated and raw Git blobs larger than the controller output budget',()=>fixture(async({write,git,inspect})=>{
  const large='翻译'.repeat(1800000);
  await write('src/translations/template.json',{...entry(''),padding:large,newEmptyField:''});
  await write(generated,{...entry('fixed'),padding:large});
  assert.equal(JSON.parse(await git('-c','http.extraHeader=Authorization: Basic test','show',`HEAD:${generated}`)).padding,large);
  assert.deepEqual(await inspect(),[{generated,raw}]);
  await write(raw,{Registry:'fixed',padding:large});
  assert.deepEqual(await inspect(),[]);
  await assert.rejects(git('cat-file','blob',`HEAD:${generated}`),/maxBuffer/);
},{generatedValue:{...entry('old'),padding:'翻译'.repeat(1800000)},rawValue:{Registry:'old',padding:'翻译'.repeat(1800000)},templateValue:{...entry(''),padding:'翻译'.repeat(1800000)}}));

test('English template field renames preserving translated values need no raw edits',()=>fixture(async({write,inspect})=>{
  await write('src/translations/template.json',{locations:{Sect:{'[title] Registry, corrected':''}}});
  await write(generated,{locations:{Sect:{'[title] Registry, corrected':'old'}}});
  assert.deepEqual(await inspect(),[]);
  await write(generated,{locations:{Sect:{'[title] Registry, corrected':'changed'}}});
  assert.deepEqual(await inspect(),[{generated,raw}]);
},{templateValue:entry('')}));

test('unverified key renames and copies still require raw source updates',()=>fixture(async({write,inspect})=>{
  await write(generated,{locations:{Sect:{'[title] New':'old'}}});
  assert.deepEqual(await inspect(),[{generated,raw}]);
  await write('src/translations/template.json',{locations:{Sect:{'[title] New':'','[title] Duplicate':''}}});
  await write(generated,{locations:{Sect:{'[title] New':'old','[title] Duplicate':'old'}}});
  assert.deepEqual(await inspect(),[{generated,raw}]);
  await write('src/translations/template.json',{locations:{Elsewhere:{'[title] New':''}}});
  await write(generated,{locations:{Elsewhere:{'[title] New':'old'}}});
  assert.deepEqual(await inspect(),[{generated,raw}]);
  await write('src/translations/template.json',{locations:{Sect:{'[description] Registry':''}}});
  await write(generated,{locations:{Sect:{'[description] Registry':'old'}}});
  assert.deepEqual(await inspect(),[{generated,raw}]);
},{templateValue:entry('')}));

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

test('renaming a generated language still requires its corresponding raw source',()=>fixture(async({git,inspect})=>{
  await git('mv',generated,'src/translations/uk.json');
  assert.deepEqual(await inspect(),[{generated:'src/translations/uk.json',raw:'translation-pipeline/raw/uk.json'}]);
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
