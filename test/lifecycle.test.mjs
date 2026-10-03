import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {main} from '../src/run.mjs';
import {readState} from '../src/core.mjs';
const exec=promisify(execFile);
test('issue -> immediate PR -> saved session -> followup -> rebased same PR',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'codex-test-'));
  const oldEnv={...process.env}, oldFetch=global.fetch;
  const remote=join(temp,'org','repo.git'), seed=join(temp,'seed'), bin=join(temp,'bin');
  const git=async(cwd,...args)=>(await exec('git',args,{cwd})).stdout.trim();
  let pr=null, sessions=0, turn=0, requests=[], failTurn=false;
  try {
    await mkdir(join(temp,'org'));await mkdir(seed);await mkdir(bin);
    await git(temp,'init','--bare',remote);await git(seed,'init','-b','main');
    await git(seed,'config','user.name','Test');await git(seed,'config','user.email','test@example.com');
    await writeFile(join(seed,'base.txt'),'base');await git(seed,'add','.');await git(seed,'commit','-m','base');
    await git(seed,'remote','add','origin',remote);await git(seed,'push','origin','main');
    await writeFile(join(bin,'docker'),`#!/usr/bin/env node
const fs=require('fs');const cp=require('child_process');const args=process.argv.slice(2);
if(args[0]==='run') {
 const mount=args[args.indexOf('--mount')+1];const dir=mount.split('source=')[1].split(',target=')[0];
 fs.writeFileSync(dir+'/implemented.txt','implemented');
 if(fs.existsSync(dir+'/.git/rebase-merge')) {
   for(const args of [['add','implemented.txt'],['rebase','--continue']]) {const result=cp.spawnSync('git',args,{cwd:dir,env:{...process.env,GIT_EDITOR:'true'}});if(result.status!==0)process.exit(result.status);}
 }
 const timer=setInterval(()=>{if(fs.existsSync(process.env.TEST_STOP)){clearInterval(timer);process.exit(0);}},10);
} else if(args[0]==='stop') fs.writeFileSync(process.env.TEST_STOP,'stop');
`,{mode:0o755});
    // Fake docker needs a stop marker but executor receives only selected environment.
    const dockerText=await readFile(join(bin,'docker'),'utf8');
    await writeFile(join(bin,'docker'),dockerText.replaceAll('process.env.TEST_STOP',JSON.stringify(join(temp,'stop'))),{mode:0o755});
    Object.assign(process.env,{PATH:bin+':'+oldEnv.PATH,RUNNER_TEMP:temp,GITHUB_REPOSITORY:'org/repo',GITHUB_API_URL:'https://github.example',GITHUB_SERVER_URL:'file://'+temp,GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1',GITHUB_ACTION_PATH:join(temp,'action'),GITHUB_EVENT_PATH:join(temp,'event.json'),GITHUB_EVENT_NAME:'issues',INPUT_GITHUB_TOKEN:'gh-test',INPUT_OPENAI_API_KEY:'ai-test',INPUT_OPENAI_EXECUTOR_API_KEY:'executor-test',INPUT_EXECUTOR_IMAGE:'fake',INPUT_STATUS_INTERVAL:'3600'});
    global.fetch=async(url, options={})=>{
      const u=new URL(url), path=u.pathname, body=options.body && JSON.parse(options.body);
      requests.push({path,method:options.method,body});
      if(u.hostname==='api.openai.com') {
        if(path.endsWith('/events') && u.search) {
          return new Response(new ReadableStream({start(controller){setTimeout(()=>{const events=[{type:'agent.session.turn.output_text.done',item_id:'msg'+turn,output_index:0,content_index:0,text:'Implemented and validated.'},{type:failTurn?'agent.session.turn.failed':'agent.session.turn.completed',turn:{subagent_id:null,error:failTurn?{message:'simulated agent failure'}:undefined}}];controller.enqueue(new TextEncoder().encode(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')));controller.close();},200);}}));
        }
        if(path.endsWith('/events')) {turn++;return Response.json({});}
        if(path==='/v1/agents/sessions') sessions++;
        return Response.json({id:'sess_1',status:'idle',environment:{id:'env_1',type:'self_hosted',workspace_directory:'/workspace',remote_url:'https://api.openai.com/v1/agents/api'},usage:{input_tokens:100,output_tokens:20,total_tokens:120}});
      }
      const prefix='/repos/org/repo';
      if(path.includes('/collaborators/')) return Response.json({permission:'admin'});
      if(path===prefix+'/pulls' && options.method==='GET') return Response.json(pr ? [pr]:[]);
      if(path===prefix+'/git/ref/heads/main') return Response.json({object:{sha:await git(seed,'rev-parse','main')}});
      if(path===prefix+'/git/ref/heads/codex%2Fissue-7') return Response.json({object:{sha:await git(temp,'--git-dir='+remote,'rev-parse','codex/issue-7')}});
      if(path.startsWith(prefix+'/git/commits/') ) return Response.json({tree:{sha:await git(seed,'rev-parse','main^{tree}')}});
      if(path===prefix+'/git/commits') {
        const sha=(await exec('git',['-C',seed,'commit-tree',body.tree,'-p',body.parents[0],'-m',body.message])).stdout.trim();
        await git(seed,'push','origin',`${sha}:refs/heads/codex/issue-7`);return Response.json({sha});
      }
      if(path===prefix+'/git/refs') return Response.json({});
      if(path===prefix+'/pulls' && options.method==='POST') {pr={...body,number:9,state:'open',node_id:'PR_9',html_url:'https://github.com/org/repo/pull/9',head:{ref:body.head,repo:{full_name:'org/repo'}},base:{ref:body.base}};return Response.json(pr);}
      if(path===prefix+'/pulls/9') {if(options.method==='PATCH')Object.assign(pr,body);return Response.json(pr);}
      if(path===prefix+'/issues/7') return Response.json({title:'Task',body:'Implement task'});
      if(path.endsWith('/comments') || path.endsWith('/reviews')) return Response.json([]);
      if(path==='/graphql') {pr.draft=false;return Response.json({data:{}});}
      throw new Error('Unexpected mocked request '+path);
    };
    await writeFile(process.env.GITHUB_EVENT_PATH,JSON.stringify({sender:{type:'User',login:'owner'},action:'labeled',label:{name:'codex'},issue:{number:7,title:'Task',body:'Implement task'},repository:{default_branch:'main'}}));
    await main();
    assert.equal(pr.title,'Task');assert.equal(pr.draft,false);assert.equal(readState(pr.body).sessionId,'sess_1');
    assert.equal(await git(seed,'ls-remote','origin','codex/issue-7').then(s=>s.length>0),true);
    const createPR=requests.findIndex(r=>r.path.endsWith('/pulls') && r.method==='POST');
    const createSession=requests.findIndex(r=>r.path==='/v1/agents/sessions');assert.ok(createPR<createSession);
    // Advance main between turns: the second execution must incorporate it.
    await writeFile(join(seed,'new-base.txt'),'new base');await git(seed,'add','.');await git(seed,'commit','-m','advance main');await git(seed,'push','origin','main');
    await rm(join(temp,'stop'));
    Object.assign(process.env,{GITHUB_RUN_ID:'2',GITHUB_EVENT_NAME:'issue_comment'});
    await writeFile(process.env.GITHUB_EVENT_PATH,JSON.stringify({sender:{type:'User',login:'owner'},action:'created',issue:{number:9,pull_request:{}},comment:{body:'@codex continue'}}));
    await main();
    assert.equal(sessions,1);assert.equal(turn,2);assert.equal(pr.number,9);assert.equal(pr.title,'Task');
    await git(seed,'fetch','origin','codex/issue-7');
    assert.equal(await git(seed,'show','FETCH_HEAD:new-base.txt'),'new base');
    assert.equal(await git(seed,'show','FETCH_HEAD:implemented.txt'),'implemented');
    assert.equal(requests.filter(r=>r.path.endsWith('/pulls') && r.method==='POST').length,1);
    // A real conflicting rebase is left for the same agent to resolve.
    await writeFile(join(seed,'implemented.txt'),'base changed the same file');await git(seed,'add','.');await git(seed,'commit','-m','conflicting main change');await git(seed,'push','origin','main');
    await rm(join(temp,'stop'));process.env.GITHUB_RUN_ID='3';
    await main();
    assert.equal(sessions,1);assert.equal(turn,3);
    const conflictRequest=requests.filter(r=>r.path.endsWith('/events') && r.body?.events?.[0]?.input).at(-1);
    assert.match(conflictRequest.body.events[0].input[0].content[0].text,/has conflicts you MUST resolve/);
    await git(seed,'fetch','origin','codex/issue-7');
    assert.equal(await git(seed,'show','FETCH_HEAD:implemented.txt'),'implemented');
    // Failed root turns must never be marked completed or pushed.
    const beforeFailure=await git(seed,'rev-parse','FETCH_HEAD');
    failTurn=true;await rm(join(temp,'stop'));process.env.GITHUB_RUN_ID='4';
    await assert.rejects(main(),/simulated agent failure/);
    assert.equal(pr.title,'[ERROR] Task');assert.match(pr.body,/simulated agent failure/);
    await git(seed,'fetch','origin','codex/issue-7');assert.equal(await git(seed,'rev-parse','FETCH_HEAD'),beforeFailure);
    assert.equal(readState(pr.body).sessionId,'sess_1');

  } finally {global.fetch=oldFetch;for(const key of Object.keys(process.env)) if(!(key in oldEnv))delete process.env[key];Object.assign(process.env,oldEnv);await rm(temp,{recursive:true,force:true});}
});
