// Handles failures where the main process could not complete its finally block.
import {API} from './api.mjs';
import {appToken} from './auth.mjs';
import {titleFor,readState,render} from './core.mjs';
const env=process.env;
const apiUrl=env.GITHUB_API_URL || 'https://api.github.com';
const token=env.INPUT_GITHUB_APP_ID && env.INPUT_GITHUB_APP_PRIVATE_KEY ? (await appToken(apiUrl,env.GITHUB_REPOSITORY,env.INPUT_GITHUB_APP_ID,env.INPUT_GITHUB_APP_PRIVATE_KEY)).token : env.INPUT_GITHUB_TOKEN;
const api=new API(apiUrl,token);
const path=`/repos/${env.GITHUB_REPOSITORY}/pulls/${Number(env.PR_NUMBER)}`;
const pr=await api.json(path);
// Preserve the detailed error already written by the main controller.
if(!pr.title.startsWith('[ERROR]')) {
  const state=readState(pr.body ?? '') || {version:1,issue:0};
  const progress={phase:'error',started:Date.now(),messages:0,message:'Workflow failed or was cancelled before final status could be saved. Use @codex to continue the durable session.',runUrl:`${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`};
  await api.json(path,{method:'PATCH',body:{title:titleFor(pr.title,'error'),body:render(pr.body ?? '',state,progress)}});
}
