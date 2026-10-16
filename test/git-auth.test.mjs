import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createAuthenticatedGit,gitOutput} from '../src/git.mjs';
import {translationSourceIssues} from '../src/translation-sources.mjs';
const exec=promisify(execFile);

test('controller translation inspection authenticates lazy fetches without persisting credentials',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'git-auth-'));
  const seed=join(temp,'seed'),workspace=join(temp,'workspace'),remote=join(temp,'repo.git');
  const token='test-private-repo-token';
  const authorization=`Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  const env={...process.env,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_GLOBAL:join(temp,'empty.gitconfig'),GIT_CONFIG_NOSYSTEM:'1'};
  const localGit=async(cwd,...args)=>(await exec('git',args,{cwd,env})).stdout.trim();
  let authenticatedRequests=0;
  const server=createServer((req,res)=>{
    if(req.headers.authorization!==authorization) {
      res.writeHead(401,{'WWW-Authenticate':'Basic realm="private git"'});res.end();return;
    }
    authenticatedRequests++;
    const url=new URL(req.url,'http://localhost');
    const child=spawn('git',['http-backend'],{env:{...env,GIT_PROJECT_ROOT:temp,GIT_HTTP_EXPORT_ALL:'1',PATH_INFO:url.pathname,QUERY_STRING:url.search.slice(1),REQUEST_METHOD:req.method,CONTENT_TYPE:req.headers['content-type'] || '',REMOTE_USER:'test',...(req.headers['content-length']?{CONTENT_LENGTH:req.headers['content-length']}:{})}});
    const chunks=[];
    child.stdout.on('data',chunk=>chunks.push(chunk));
    child.stderr.resume();
    child.on('error',error=>res.destroy(error));
    child.on('close',()=>{
      const output=Buffer.concat(chunks),end=output.indexOf('\r\n\r\n');
      if(end<0){res.writeHead(500);res.end(output);return;}
      for(const header of output.subarray(0,end).toString().split('\r\n')) {
        const colon=header.indexOf(':');if(colon<0)continue;
        const name=header.slice(0,colon),value=header.slice(colon+1).trim();
        if(name.toLowerCase()==='status')res.statusCode=Number(value.split(' ')[0]);
        else res.setHeader(name,value);
      }
      res.end(output.subarray(end+4));
    });
    req.pipe(child.stdin);
  });
  try {
    await mkdir(seed);await mkdir(workspace);
    await localGit(temp,'init','--bare',remote);
    await localGit(temp,'--git-dir='+remote,'config','uploadpack.allowFilter','true');
    await localGit(temp,'--git-dir='+remote,'config','uploadpack.allowAnySHA1InWant','true');
    await localGit(seed,'init');await localGit(seed,'config','user.name','Test');await localGit(seed,'config','user.email','test@example.com');
    const generated='src/translations/ru.json',raw='translation-pipeline/raw/ru.json';
    for(const [file,value] of [[generated,{label:'old translation'}],[raw,{label:'old source'}]]) {
      await mkdir(dirname(join(seed,file)),{recursive:true});await writeFile(join(seed,file),JSON.stringify(value));
    }
    await writeFile(join(seed,'old-asset.bin'),'historical asset\n'.repeat(1000));
    await localGit(seed,'add','.');await localGit(seed,'commit','-m','base');
    await localGit(seed,'branch','base');
    const historicalAsset=await localGit(seed,'rev-parse','base:old-asset.bin');
    await rm(join(seed,'old-asset.bin'));await writeFile(join(seed,'new-asset.bin'),'historical asset\n'.repeat(999)+'updated asset\n');
    await writeFile(join(seed,generated),JSON.stringify({label:'fixed translation'}));
    await localGit(seed,'add','.');await localGit(seed,'commit','-m','generated-only translation change and renamed asset');
    await localGit(seed,'push',remote,'base', 'HEAD:refs/heads/agent');
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    await localGit(workspace,'init');
    await localGit(workspace,'remote','add','origin',`http://127.0.0.1:${server.address().port}/repo.git`);
    const git=createAuthenticatedGit((...args)=>gitOutput(args,{cwd:workspace,env}),async()=>token,async()=>{});
    await git('fetch','--filter=blob:none','origin','base:refs/remotes/origin/base','agent:refs/remotes/origin/agent');
    await git('checkout','-b','agent','refs/remotes/origin/agent');
    // Checkout fetched the new snapshot, but the baseline translation remains missing.
    await assert.rejects(localGit(workspace,'diff','--name-only','--diff-filter=ACMRT','refs/remotes/origin/base'),/could not fetch|terminal prompts disabled/);
    await assert.rejects(localGit(workspace,'show',`refs/remotes/origin/base:${generated}`),/could not fetch|terminal prompts disabled/);
    const requestsBefore=authenticatedRequests;
    assert.deepEqual(await translationSourceIssues({workspace,git}),[{generated,raw}]);
    assert.ok(authenticatedRequests>requestsBefore,'inspection must authenticate the missing baseline blob download');
    const missing=await git('rev-list','--objects','--missing=print','refs/remotes/origin/base');
    assert.ok(missing.split('\n').includes('?'+historicalAsset),'inspection must leave unrelated historical assets on the remote');
    assert.doesNotMatch(await readFile(join(workspace,'.git','config'),'utf8'),/extraheader|Authorization|test-private-repo-token/i);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    await rm(temp,{recursive:true,force:true});
  }
});

test('controller Git refreshes command credentials and never retries a push',async()=>{
  const calls=[];let refreshes=0;
  const git=createAuthenticatedGit(async(...args)=>{calls.push(args);if(args.includes('push'))throw new Error('RPC failed');return 'ok';},async()=>`token-${++refreshes}`,async()=>{});
  await git('diff','--name-only');await git('show','base:file');
  await assert.rejects(git('push','--force-with-lease','origin','HEAD'),/RPC failed/);
  assert.equal(calls.length,3);
  calls.forEach((args,index)=>assert.equal(args[1],`http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:token-${index+1}`).toString('base64')}`));
});
