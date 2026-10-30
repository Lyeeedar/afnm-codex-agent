import {readFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';

const legacyTranslationInstructions=`Legacy AFNM translation checkout: translation-pipeline/raw/<language>.json is the editable source. src/translations/<language>.json is generated output and corrections made only there will be overwritten by the next sync. Update the corresponding raw language file first, then sync or update the matching generated entries. Read the repository's field-key and sync helpers to find the exact raw key, including translation context and whitespace. Preserve unrelated entries and placeholders. English source-string corrections belong in the authored source and extracted template; generated field-key renames that preserve the existing translated values do not require unrelated raw changes. Before finishing, inspect the PR diff and confirm every language with changed translations has its corresponding raw source update. State which raw and generated files changed in your final report. This applies on follow-up turns too. If resolving the rebase introduces src/translations/metadata.json with format afnm-translation-metadata, switch to the grouped workflow in shared/translations/README.md instead. Never recreate retired raw language files on a migrated checkout.`;

export const translationInstructions=`Current AFNM grouped translation checkout. These instructions supersede any raw/generated translation instructions from earlier session turns. src/translations/<language>.json and its listed parts are the authoritative targets. src/translations/metadata.json and its parts hold the shared English catalogue and context. translation-pipeline/raw/ retains guidance and review evidence only. Never recreate translation-pipeline/raw/<language>.json, overwrite a manifest with a community export, hand-edit parts/metadata/aliases, or treat part files as separate languages. Read AGENTS.md and shared/translations/README.md before translation work.

For spelling/wording bug reports, start at the repository root with npm run translations -- find --query "reported text". Specify --language <code> for translated text, or --language all when unknown. Then run lookup --language <code> --key "exact identity" and inspect source locations, translated neighbours, guidance, all relevant occurrences and compatibility variants. Expand paginated context when necessary. Author the correction yourself after checking meaning and mechanics. Use read-only check, then guarded set with --expect-value "current target", or --value-file and the lookup --revision for multiline text. Choose --runtime or --occurrence-id deliberately when correcting only that compatibility value. Canonical replacement of exceptions requires reviewing every affected use and --acknowledge-compatibility. Do not replace a language to fix one entry.

For English corrections, edit the actual source identified by lookup using the applicable content skill, then run npm run extract-translations and inspect the diff. Do not edit generated identities or metadata. Only for unchanged-meaning spelling corrections, preview carry-english --from-key "old identity" --key "corrected identity" --same-meaning, review its plan, then add --apply. Conflicting variants need manual review and meaning changes need fresh translation review.

Only when explicitly asked to translate all missing text, extract changed English first and run npm run translations -- untranslated. Use batch --language <code> --output output/translation-work/<code>-001.batch.json, read the packet and relevant paginated context, and author a separate answers JSON with values, reviewed:true and specific deferred reasons. Run check-batch then apply-batch. Resume using a new filename and --after-packet. Finish by rerunning untranslated without a cursor and report exact remaining counts and reasons. Names identical to English can be valid translations. Do not run bulk translation for a single bug report.

All validation is read-only. Do not run pipeline repairs, normalization, glossary substitutions or external translation APIs. Preserve unrelated approved targets, historical variants and durable guidance. Use the transactional CLI writer, which preserves replaced values in the archive. Packets, answers and exports belong in ignored output/ or reports/, never in commits. Before finishing run npm run translations -- verify for catalogue changes and appropriate source validation. Report exact identities, affected uses and checks, not a claim that matching placeholders proves translation quality. This applies on follow-up turns too.`;

const metadataFile='src/translations/metadata.json';
const retiredLanguage=/^translation-pipeline\/raw\/[a-z]{2,3}(?:-[A-Za-z0-9]+)*\.json$/;

async function catalogueState({workspace,git,baseline='refs/remotes/origin/base'}) {
  let current;
  try{current=JSON.parse(await readFile(join(workspace,metadataFile),'utf8'));}
  catch(error){if(error.code!=='ENOENT' && !(error instanceof SyntaxError))throw error;}
  if(current?.format==='afnm-translation-metadata')return {grouped:true,current};
  // A deleted, malformed or downgraded catalogue must not disable the guard.
  if(await git('ls-tree','--name-only',baseline,'--',metadataFile)) {
    const original=JSON.parse(await git('show',`${baseline}:${metadataFile}`));
    if(original?.format==='afnm-translation-metadata')return {grouped:true,current};
  }
  return {grouped:false,current};
}

export async function translationInstructionsFor(options) {
  return (await catalogueState(options)).grouped ? translationInstructions : legacyTranslationInstructions;
}

function translatedValuesChanged(before,after,beforeTemplate,afterTemplate) {
  if(typeof after==='string')return after!==before && (after!=='' || typeof before==='string');
  if(!after || typeof after!=='object')return false;
  // English edits rename generated field keys. A matching template rename in
  // the same context may carry an existing translation without changing raw.
  // Count candidates so one removed field cannot excuse multiple additions.
  const renamed=new Map();
  const field=key=>key.match(/^\[[^\]]+\]/)?.[0];
  for(const [key,value] of Object.entries(before ?? {})) {
    if(typeof value!=='string' || !field(key) || Object.hasOwn(after,key) ||
      typeof beforeTemplate?.[key]!=='string' || Object.hasOwn(afterTemplate ?? {},key))continue;
    const identity=JSON.stringify([field(key),value]);
    renamed.set(identity,(renamed.get(identity) ?? 0)+1);
  }
  return Object.entries(after).some(([key,value])=>{
    if(typeof value==='string' && !Object.hasOwn(before ?? {},key) && field(key) &&
      typeof afterTemplate?.[key]==='string' && !Object.hasOwn(beforeTemplate ?? {},key)) {
      const identity=JSON.stringify([field(key),value]),count=renamed.get(identity) ?? 0;
      if(count) {renamed.set(identity,count-1);return false;}
    }
    return translatedValuesChanged(before?.[key],value,beforeTemplate?.[key],afterTemplate?.[key]);
  });
}

async function legacyTranslationSourceIssues({workspace,git,baseline='refs/remotes/origin/base'}) {
  try{await access(join(workspace,'translation-pipeline','raw'));}
  catch(error){
    if(error.code!=='ENOENT')throw error;
    if(!await git('ls-tree','--name-only',baseline,'--','translation-pipeline/raw'))return [];
  }
  // Rename similarity checks can download unrelated historical assets in a partial clone.
  // A renamed language is checked as a new file, so content-based rename detection is unnecessary.
  const changed=await git('diff','--name-only','--no-renames','--diff-filter=ACMT',baseline,'--','src/translations/');
  const untracked=await git('ls-files','--others','--exclude-standard','--','src/translations/');
  const changedFiles=new Set((changed+'\n'+untracked).split('\n'));
  const files=[...changedFiles].filter(file=>/^src\/translations\/[a-z]{2,3}(?:-[A-Za-z0-9]+)*\.json$/.test(file));
  const original=async file=>{
    if(!await git('ls-tree','--name-only',baseline,'--',file))return {};
    return JSON.parse(await git('show',`${baseline}:${file}`));
  };
  let beforeTemplate,afterTemplate;
  if(files.length && changedFiles.has('src/translations/template.json')) {
    beforeTemplate=await original('src/translations/template.json');
    afterTemplate=JSON.parse(await readFile(join(workspace,'src/translations/template.json'),'utf8'));
  }
  const issues=[];
  for(const generated of files) {
    const current=JSON.parse(await readFile(join(workspace,generated),'utf8'));
    if(!translatedValuesChanged(await original(generated),current,beforeTemplate,afterTemplate))continue;
    const raw='translation-pipeline/raw/'+generated.split('/').at(-1);
    let source;
    try{source=JSON.parse(await readFile(join(workspace,raw),'utf8'));}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(source===undefined || isDeepStrictEqual(source,await original(raw)))issues.push({generated,raw});
  }
  return issues;
}

export async function translationSourceIssues({workspace,git,baseline='refs/remotes/origin/base',verify}) {
  const state=await catalogueState({workspace,git,baseline});
  if(!state.grouped)return legacyTranslationSourceIssues({workspace,git,baseline});
  const changed=await git('diff','--name-only','--no-renames',baseline,'--','src/translations/','translation-pipeline/raw/');
  const untracked=await git('ls-files','--others','--exclude-standard','--','src/translations/','translation-pipeline/raw/');
  const files=[...new Set((changed+'\n'+untracked).split('\n').filter(Boolean))];
  const issues=[];
  if(state.current?.format!=='afnm-translation-metadata')issues.push({file:metadataFile,message:'Restore the valid shared catalogue. Do not delete it or replace it with a legacy export.'});
  for(const file of files.filter(file=>retiredLanguage.test(file))) {
    try{await access(join(workspace,file));}
    catch(error){if(error.code==='ENOENT')continue;throw error;}
    issues.push({file,message:'Retired raw language file changed or recreated. Publish the intended correction through the canonical CLI and remove this duplicate export from the PR. Preserve guidance and review evidence.'});
  }
  if(issues.length || !files.some(file=>file.startsWith('src/translations/')))return issues;
  if(!verify)throw new Error('Grouped translation verification requires the isolated executor');
  // Use this checkout's shared readers, not a second implementation of its format.
  // The callback runs read-only verification inside the credential-free executor.
  try{await verify();}
  catch(error){issues.push({file:'src/translations/',message:`Read-only catalogue verification failed. Resolve the reported storage issue without discarding approved values: ${String(error.stderr || error.message).slice(-12000)}`});}
  return issues;
}

export async function completeTranslationSources({prompt,runTurn,inspect,instructions=translationInstructions,report=async()=>{},maxCorrections=2}) {
  await runTurn(prompt,0);
  for(let correction=1;;correction++) {
    const issues=await inspect();
    if(!issues.length)return;
    const files=issues.map(issue=>issue.message ? `${issue.file}: ${issue.message}` : `${issue.generated} needs a corresponding update in ${issue.raw}`).join('\n');
    if(correction>maxCorrections)throw new Error(`Agent left translation storage issues after ${maxCorrections} automatic repair turns:\n${files}`);
    await report(`Translation storage check failed. Asking the same agent to resolve the reported issues (repair ${correction}/${maxCorrections})…`);
    const guidance=typeof instructions==='function' ? await instructions() : instructions;
    await runTurn(`Your preceding turn left translation storage issues. Repair the existing implementation before finishing. Preserve completed work and resolve these findings:\n${files}\n\n${guidance}\n\nRun the relevant validation and update your final report. Do not leave a rebase in progress.`,correction);
  }
}
