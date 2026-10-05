import test from 'node:test';
import assert from 'node:assert/strict';
import {issuePR} from '../src/issue-pr.mjs';
import {Progress,readState} from '../src/core.mjs';

const options=()=>({repo:'org/repo',issue:7,base:'main',title:'Task',progress:Object.assign(new Progress(),{phase:'running',started:Date.now(),runUrl:'https://example.com/run'})});
function mock(matches,{retained=false,creationError}={}) {
  const calls=[];
  return {calls,async list(path){calls.push({path});return matches;},async json(path,request={}) {
    calls.push({path,...request});
    if(path.endsWith('/git/ref/heads/main'))return {object:{sha:'latest-base'}};
    if(path.endsWith('/git/commits/latest-base'))return {tree:{sha:'base-tree'}};
    if(path.endsWith('/git/commits'))return {sha:'fresh-commit'};
    if(path.endsWith('/git/refs')) {
      if(creationError)throw creationError;
      if(retained)throw Object.assign(new Error('Ref exists'),{status:422});
      return {};
    }
    if(path.endsWith('/git/ref/heads/codex%2Fissue-7'))return {object:{sha:'old-work'}};
    if(path.endsWith('/git/refs/heads/codex%2Fissue-7'))return {};
    if(path.endsWith('/pulls'))return {...request.body,number:10,state:'open'};
    throw new Error('Unexpected request '+path);
  }};
}

for(const merged of [false,true])for(const retained of [false,true]) {
  test(`starts fresh after ${merged?'merged':'closed'} PR with ${retained?'retained':'deleted'} branch`,async()=>{
    const gh=mock([{number:9,state:'closed',merged_at:merged?'2026-01-01':null,body:'old session'}],{retained});
    const pr=await issuePR(gh,options());
    assert.equal(pr.number,10);
    assert.deepEqual(readState(pr.body),{version:1,issue:7});
    assert.equal(pr.draft,true);
    assert.equal(pr.head,'codex/issue-7');
    const commit=gh.calls.find(c=>c.path.endsWith('/git/commits'));
    assert.deepEqual(commit.body.parents,['latest-base']);
    assert.equal(commit.body.tree,'base-tree');
    const reset=gh.calls.find(c=>c.method==='PATCH');
    assert.equal(Boolean(reset),retained);
    if(retained)assert.deepEqual(reset.body,{sha:'fresh-commit',force:true});
    assert.ok(gh.calls.every(c=>!c.path.includes('/pulls/9')));
  });
}

test('resumes the open PR even when an older closed PR exists',async()=>{
  const open={number:10,state:'open',body:'saved session'};
  const gh=mock([{number:9,state:'closed'},open]);
  assert.equal(await issuePR(gh,options()),open);
  assert.equal(gh.calls.length,1);
});

test('first issue run creates its branch without resetting it',async()=>{
  const gh=mock([]);
  await issuePR(gh,options());
  assert.equal(gh.calls.some(c=>c.method==='PATCH'),false);
});

test('branch creation authorization failures are surfaced without resetting or creating a PR',async()=>{
  const error=Object.assign(new Error('Forbidden'),{status:403});
  const gh=mock([{state:'closed'}],{creationError:error});
  await assert.rejects(issuePR(gh,options()),error);
  assert.equal(gh.calls.some(c=>c.method==='PATCH' || c.path.endsWith('/pulls')),false);
});
