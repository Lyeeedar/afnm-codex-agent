import {readFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';

export const translationInstructions=`AFNM translation fixes: translation-pipeline/raw/<language>.json is the editable source. src/translations/<language>.json is generated output and corrections made only there will be overwritten by the next sync. Update the corresponding raw language file first, then sync or update the matching generated entries. Read the repository's field-key and sync helpers to find the exact raw key, including translation context and whitespace. Preserve unrelated entries and placeholders. Before finishing, inspect the PR diff and confirm every language with changed translations has its corresponding raw source update. State which raw and generated files changed in your final report. This applies on follow-up turns too.`;

function translatedValuesChanged(before,after) {
  if(typeof after==='string')return after!==before && (after!=='' || typeof before==='string');
  if(!after || typeof after!=='object')return false;
  return Object.entries(after).some(([key,value])=>translatedValuesChanged(before?.[key],value));
}

export async function translationSourceIssues({workspace,git,baseline='refs/remotes/origin/base'}) {
  try{await access(join(workspace,'translation-pipeline','raw'));}
  catch(error){
    if(error.code!=='ENOENT')throw error;
    if(!await git('ls-tree','--name-only',baseline,'--','translation-pipeline/raw'))return [];
  }
  const changed=await git('diff','--name-only','--diff-filter=ACMRT',baseline);
  const untracked=await git('ls-files','--others','--exclude-standard');
  const files=[...new Set((changed+'\n'+untracked).split('\n'))].filter(file=>/^src\/translations\/[a-z]{2,3}(?:-[A-Za-z0-9]+)*\.json$/.test(file));
  const original=async file=>{
    if(!await git('ls-tree','--name-only',baseline,'--',file))return {};
    return JSON.parse(await git('show',`${baseline}:${file}`));
  };
  const issues=[];
  for(const generated of files) {
    const current=JSON.parse(await readFile(join(workspace,generated),'utf8'));
    if(!translatedValuesChanged(await original(generated),current))continue;
    const raw='translation-pipeline/raw/'+generated.split('/').at(-1);
    let source;
    try{source=JSON.parse(await readFile(join(workspace,raw),'utf8'));}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(source===undefined || isDeepStrictEqual(source,await original(raw)))issues.push({generated,raw});
  }
  return issues;
}

export async function completeTranslationSources({prompt,runTurn,inspect,report=async()=>{},maxCorrections=2}) {
  await runTurn(prompt,0);
  for(let correction=1;;correction++) {
    const issues=await inspect();
    if(!issues.length)return;
    const files=issues.map(({generated,raw})=>`${generated} needs a corresponding update in ${raw}`).join('\n');
    if(correction>maxCorrections)throw new Error(`Agent left generated-only translation edits after ${maxCorrections} automatic repair turns:\n${files}`);
    await report(`Translation source check failed. Asking the same agent to update raw sources (repair ${correction}/${maxCorrections})…`);
    await runTurn(`Your preceding turn changed generated translations without updating their raw sources. Repair the existing implementation before finishing. Preserve completed work and resolve these missing source updates:\n${files}\n\n${translationInstructions}\n\nRun the relevant validation and update your final report. Do not leave a rebase in progress.`,correction);
  }
}
