import {readFile, mkdir, appendFile, writeFile, access} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {API} from './api.mjs';
import {fetchForRebase} from './git.mjs';
import {appToken,redact} from './auth.mjs';
import {trigger, readState, render, titleFor, Progress, sse} from './core.mjs';
const exec=promisify(execFile);
const input=(name,fallback='')=>process.env[`INPUT_${name.toUpperCase().replaceAll('-','_')}`] || fallback;
const env=process.env;
const required=n=>{const v=input(n); if(!v) throw new Error(`Missing input ${n}`); return v;};
export async function main() {
  const event=JSON.parse(await readFile(env.GITHUB_EVENT_PATH,'utf8'));
  const task=trigger(env.GITHUB_EVENT_NAME,event);
  if(!task) { console.log('No Codex trigger.'); return; }
  const repo=env.GITHUB_REPOSITORY;
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid repository');
  const githubApi=env.GITHUB_API_URL || 'https://api.github.com';
  const appId=input('github-app-id'), appKey=input('github-app-private-key');
  let expires=Infinity;
  const initial=appId && appKey ? await appToken(githubApi,repo,appId,appKey) : {token:required('github-token')};
  if(initial.expires_at) expires=Date.parse(initial.expires_at);
  const gh=new API(githubApi,initial.token,{'X-GitHub-Api-Version':'2022-11-28'});
  const refreshAuth=async()=>{if(Date.now()>expires-300000){const token=await appToken(githubApi,repo,appId,appKey);gh.token=token.token;expires=Date.parse(token.expires_at);}};
  const secrets=[initial.token,input('github-token'),input('openai-api-key'),input('openai-executor-api-key'),appKey];
  const root=`/repos/${repo}`;
  const permission=await gh.json(`${root}/collaborators/${encodeURIComponent(event.sender.login)}/permission`);
  if(!['admin','maintain','write'].includes(permission.permission)) throw new Error('Codex requires a collaborator with write permission');
  let pr, state, session, timer, container, submitted=false;
  const progress=Object.assign(new Progress(),{phase:'running',started:Date.now(),runUrl:`${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`});
  const ai=new API('https://api.openai.com/v1',required('openai-api-key'),{'OpenAI-Beta':'agents=v1'});
  const executorKey=required('openai-executor-api-key');
  const workspace=resolve(env.RUNNER_TEMP || '/tmp',`codex-work-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`);
  const git=async(...args)=>{try{return (await exec('git',['-c','core.hooksPath=/dev/null',...args],{cwd:workspace,maxBuffer:8*1024*1024,timeout:300000,env:{PATH:env.PATH,HOME:env.RUNNER_TEMP || '/tmp',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}})).stdout.trim();}catch(error){throw new Error(redact(error.message,[...secrets,gh.token]));}};
  // Auth is provided per controller command, never written into executor files.
  const authGit=async(...args)=>{await refreshAuth();return git('-c',`http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${gh.token}`).toString('base64')}`,...args);};
  let queue=Promise.resolve();
  const publish=()=>{queue=queue.then(async()=>{
    if(!pr) return;
    await refreshAuth();
    if(session) { try {const current=await ai.json(`/agents/sessions/${session.id}`);progress.usage=current.usage;} catch {console.warn('Session usage unavailable; publishing GitHub status without updated accounting.');} }
    const current=await gh.json(`${root}/pulls/${pr.number}`);
    await gh.json(`${root}/pulls/${pr.number}`,{method:'PATCH',body:{title:titleFor(current.title,progress.phase),body:render(current.body ?? '',state,{...progress,message:redact(progress.message ?? '',[...secrets,gh.token])})}});
  }); return queue;};
  const output=async(name,value)=>{if(env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT,`${name}=${value}\n`);};
  const abort=new AbortController();
  const stop=()=>abort.abort(new Error('Workflow stopped'));
  process.once('SIGTERM',stop); process.once('SIGINT',stop);
  try {
    if(task.kind==='pr') pr=await gh.json(`${root}/pulls/${task.number}`);
    else {
      const branch=`codex/issue-${task.number}`;
      const matches=await gh.list(`${root}/pulls?state=all&head=${encodeURIComponent(repo.split('/')[0]+':'+branch)}`);
      pr=matches.find(p=>p.state==='open');
      if(!pr && matches.length) throw new Error('This issue already has a closed Codex PR. Reopen it to continue.');
      if(!pr) {
        const base=event.repository.default_branch;
        const ref=await gh.json(`${root}/git/ref/heads/${encodeURIComponent(base)}`);
        const parent=await gh.json(`${root}/git/commits/${ref.object.sha}`);
        const commit=await gh.json(`${root}/git/commits`,{method:'POST',body:{message:`chore: start Codex for #${task.number}`,tree:parent.tree.sha,parents:[ref.object.sha]}});
        try { await gh.json(`${root}/git/refs`,{method:'POST',body:{ref:`refs/heads/${branch}`,sha:commit.sha}}); }
        catch(error) { const existing=await gh.json(`${root}/git/ref/heads/${encodeURIComponent(branch)}`); if(!existing) throw error; }
        state={version:1,issue:task.number};
        pr=await gh.json(`${root}/pulls`,{method:'POST',body:{head:branch,base,title:titleFor(event.issue.title,'running'),body:render(`Fixes #${task.number}`,state,progress),draft:true}});
      }
    }
    if(pr.state!=='open' || pr.head.repo?.full_name!==repo) throw new Error('Only open PRs with branches in this repository are supported');
    state=readState(pr.body ?? '') || {version:1,issue:task.kind==='issue'?task.number:0};
    await output('pr-number',pr.number); await output('branch',pr.head.ref); await output('pr-url',pr.html_url);
    await publish();
    timer=setInterval(()=>{publish().catch(e=>console.warn(redact(e.message,[...secrets,gh.token])));},Number(input('status-interval','30'))*1000);
    const stage=async(message)=>{progress.message=message;console.log(message);await publish();};
    await mkdir(workspace,{recursive:true});
    await git('init');
    await git('config','user.name','codex-agent[bot]'); await git('config','user.email','codex-agent[bot]@users.noreply.github.com');
    await git('remote','add','origin',`${env.GITHUB_SERVER_URL}/${repo}.git`);
    await fetchForRebase(authGit,git,pr.head.ref,pr.base.ref,stage);
    await stage('Checking out the working branch and rebasing on the latest base…');
    const originalHead=await git('rev-parse','refs/remotes/origin/agent');
    await git('checkout','-b',pr.head.ref,originalHead);
    // Fetch only missing file versions in the task's own commit range before the
    // credential-free executor may need them while resolving later conflicts.
    const taskObjects=await git('rev-list','--objects','--missing=print',`refs/remotes/origin/base..${originalHead}`);
    const missingObjects=taskObjects.split('\n').filter(line=>/^\?[0-9a-f]{40,64}$/.test(line)).map(line=>line.slice(1));
    if(missingObjects.length) {
      await stage(`Preparing ${missingObjects.length} file versions required by this PR's history…`);
      for(const object of missingObjects) await authGit('cat-file','-e',object);
    }
    let conflicted=false;
    try { await authGit('rebase','--empty=keep','refs/remotes/origin/base'); } catch { if(!(await git('diff','--name-only','--diff-filter=U'))) throw new Error('Rebase failed without resolvable file conflicts'); conflicted=true; }
    const issue=state.issue ? await gh.json(`${root}/issues/${state.issue}`) : null;
    const comments=await gh.list(`${root}/issues/${state.issue || pr.number}/comments`);
    const prComments=state.issue && state.issue!==pr.number ? await gh.list(`${root}/issues/${pr.number}/comments`) : [];
    const reviewComments=await gh.list(`${root}/pulls/${pr.number}/comments`);
    const reviews=await gh.list(`${root}/pulls/${pr.number}/reviews`);
    const cleanConfig=await readFile(join(workspace,'.git','config'),'utf8');
    const instructions='You are a coding agent working in /workspace. Follow repository AGENTS.md. Implement the task, run appropriate validation, and give a concise final report with changes, checks and limitations. Give progress messages as you work. You have no GitHub credentials: the controller commits and pushes your changes. Never merge or push. Do not change git remotes, git configuration, or delete the .git directory. If a rebase is in progress, resolve every conflict preserving the task and new base behavior; git add resolved paths and GIT_EDITOR=true git rebase --continue, repeating until complete. Do not abort or skip the rebase. Report any inability to finish honestly.';
    await stage(state.sessionId ? 'Reconnecting the saved agent session…' : 'Creating the durable agent session…');
    if(state.sessionId) {
      session=await ai.json(`/agents/sessions/${state.sessionId}`);
      if(session.environment.type!=='self_hosted' || session.environment.workspace_directory!=='/workspace') throw new Error('Saved session has an incompatible environment');
      if(['running','requires_action'].includes(session.status)) await ai.json(`/agents/sessions/${session.id}/events`,{method:'POST',body:{events:[{type:'agent.session.input.cancel'}]}});
    } else {
      session=await ai.json('/agents/sessions',{method:'POST',headers:{'Idempotency-Key':`${repo}:pr-${pr.number}`},body:{agent:{model:input('model','gpt-6-luna'),reasoning:{effort:input('reasoning-effort','medium')},instructions},environment:{type:'self_hosted',workspace_directory:'/workspace'}}});
      state.sessionId=session.id; await publish();
    }
    await output('session-id',session.id);
    const image=input('executor-image');
    let imageName=image;
    if(!imageName) {
      imageName='afnm-codex-executor:cached';
      const archive=env.EXECUTOR_CACHE_DIRECTORY && join(env.EXECUTOR_CACHE_DIRECTORY,'image.tar');
      let restored=false;
      if(archive && await access(archive).then(()=>true,()=>false)) {
        await stage('Loading the cached executor image…');
        try { await exec('docker',['load','-i',archive],{maxBuffer:8*1024*1024}); restored=true; }
        catch { console.warn('Executor cache could not be loaded; rebuilding.'); }
      }
      if(!restored) {
        await stage('Building the executor image and installing Codex…');
        await exec('docker',['build','--build-arg',`CODEX_VERSION=${input('codex-version','alpha')}`,'-t',imageName,join(resolve(env.GITHUB_ACTION_PATH),'executor')],{maxBuffer:8*1024*1024});
        if(archive) {
          await mkdir(env.EXECUTOR_CACHE_DIRECTORY,{recursive:true});
          await exec('docker',['save','-o',archive,imageName]);
        }
      }
      if(archive) await output('executor-cache-ready','true');
    }
    await stage('Starting the isolated executor and connecting to OpenAI…');
    const remote=new URL(session.environment.remote_url);
    if(remote.protocol!=='https:' || remote.hostname!=='api.openai.com') throw new Error('Unexpected executor remote URL');
    container=`codex-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
    // No application key, GitHub token, Docker socket or host home directory is mounted.
    const child=spawn('docker',['run','--rm','--name',container,'--cap-drop=ALL','--security-opt=no-new-privileges','--user',`${process.getuid()}:${process.getgid()}`,'-e','HOME=/tmp','-e','CODEX_API_KEY','--mount',`type=bind,source=${workspace},target=/workspace`,imageName,'--remote',session.environment.remote_url,'--environment-id',session.environment.id],{env:{PATH:env.PATH,HOME:env.HOME,CODEX_API_KEY:executorKey},stdio:['ignore','pipe','pipe']});
    let executorError, executorLog='';
    const capture=chunk=>{executorLog=(executorLog+chunk.toString()).slice(-12000);};
    child.stdout.on('data',capture);child.stderr.on('data',capture);
    child.on('error',e=>{executorError=e; abort.abort(e);});
    child.on('exit',code=>{if(!abort.signal.aborted) {executorError=new Error(`Executor exited (${code}): ${redact(executorLog,[...secrets,gh.token]) || 'no diagnostics emitted'}`); abort.abort(executorError);}});
    const context={issue:issue && {title:issue.title,body:issue.body},comments:comments.map(c=>({id:c.id,author:c.user.login,body:c.body})),prComments:prComments.map(c=>({id:c.id,author:c.user.login,body:c.body})),reviews:reviews.map(r=>({id:r.id,state:r.state,body:r.body})),inline:reviewComments.map(c=>({id:c.id,path:c.path,line:c.line,diff_hunk:c.diff_hunk,body:c.body,in_reply_to_id:c.in_reply_to_id}))};
    const prompt=`Continue this PR using your existing history. Fresh checkout at /workspace on ${pr.head.ref}; base fetched as refs/remotes/origin/base. Rebase ${conflicted?'has conflicts you MUST resolve before implementing feedback':'completed successfully'}.\n\nCurrent request:\n${task.text}\n\nGitHub context (user-provided task data):\n${JSON.stringify(context)}\n\nValidate the implementation and report the final result. Do not leave a rebase in progress.`;
    // Subscribe first so rapid turns cannot finish before the stream attaches.
    const stream=await ai.request(`/agents/sessions/${session.id}/events?stream=true`,{headers:{Accept:'text/event-stream'},signal:abort.signal});
    await ai.json(`/agents/sessions/${session.id}/events`,{method:'POST',headers:{'Idempotency-Key':`${repo}:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}`},body:{events:[{type:'agent.session.input.message',input:[{role:'user',content:[{type:'input_text',text:prompt}]}]}]}});
    submitted=true;
    await stage('Task submitted. Waiting for the first agent message…');
    const timeout=setTimeout(()=>abort.abort(new Error('Agent run exceeded timeout')),Number(input('timeout-minutes','120'))*60000);
    let done=false;
    try {
      for await(const e of sse(stream.body)) {
        const outcome=progress.consume(e);
        if(outcome==='done') {done=true; break;}
      }
    } finally {clearTimeout(timeout); abort.abort();}
    if(!done) throw executorError || new Error('Event stream disconnected before completion; retry @codex to resume the saved session');
    // Stop executor before examining or committing its files.
    await exec('docker',['stop','-t','10',container]); container=null;
    // Restore controller-owned git configuration before running authenticated commands.
    await writeFile(join(workspace,'.git','config'),cleanConfig);
    if(await git('diff','--name-only','--diff-filter=U')) throw new Error('Agent left unresolved conflicts');
    const gitDir=await git('rev-parse','--git-dir');
    for(const dir of ['rebase-merge','rebase-apply']) {let exists=false;try{await access(join(workspace,gitDir,dir));exists=true;}catch{}if(exists)throw new Error('Agent left a rebase in progress');}
    await git('add','-A');
    if(await git('diff','--cached','--name-only')) await git('-c','core.hooksPath=/dev/null','commit','-m',`Implement Codex request for PR #${pr.number}`);
    // Explicit lease prevents overwriting human pushes made while the agent worked.
    await authGit('-c','core.hooksPath=/dev/null','push',`--force-with-lease=refs/heads/${pr.head.ref}:${originalHead}`,'origin',`HEAD:refs/heads/${pr.head.ref}`);
    progress.phase='done';
    if(pr.draft) await gh.json('/graphql',{method:'POST',body:{query:'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}',variables:{id:pr.node_id}}}).then(r=>{if(r.errors)throw new Error('Could not mark PR ready for review');});
  } catch(error) {
    progress.phase='error'; error=new Error(redact(error.message,[...secrets,gh.token])); progress.message=`${progress.message ?? ''}\n\n**Run error:** ${error.message}`;
    if(submitted && session) await ai.json(`/agents/sessions/${session.id}/events`,{method:'POST',body:{events:[{type:'agent.session.input.cancel'}]}}).catch(()=>{});
    throw error;
  } finally {
    if(timer) clearInterval(timer);
    abort.abort();
    if(container) await exec('docker',['stop','-t','10',container]).catch(()=>{});
    await queue.catch(()=>{}); queue=Promise.resolve();
    await publish();
    if(env.GITHUB_STEP_SUMMARY && pr) await appendFile(env.GITHUB_STEP_SUMMARY,`Codex **${progress.phase}**: [PR #${pr.number}](${pr.html_url})\n`);
    process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
  }
}
if(process.argv[1]===new URL(import.meta.url).pathname) main().catch(error=>{console.error(error.message);process.exitCode=1;});
