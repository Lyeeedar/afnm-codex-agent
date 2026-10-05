import {render,titleFor} from './core.mjs';

export async function issuePR(gh,{repo,issue,base,title,progress}) {
  const root=`/repos/${repo}`, branch=`codex/issue-${issue}`;
  const matches=await gh.list(`${root}/pulls?state=all&head=${encodeURIComponent(repo.split('/')[0]+':'+branch)}`);
  const open=matches.find(pr=>pr.state==='open');
  if(open)return open;

  const ref=await gh.json(`${root}/git/ref/heads/${encodeURIComponent(base)}`);
  const parent=await gh.json(`${root}/git/commits/${ref.object.sha}`);
  const commit=await gh.json(`${root}/git/commits`,{method:'POST',body:{message:`chore: start Codex for #${issue}`,tree:parent.tree.sha,parents:[ref.object.sha]}});
  try {
    await gh.json(`${root}/git/refs`,{method:'POST',body:{ref:`refs/heads/${branch}`,sha:commit.sha}});
  } catch(error) {
    // GitHub may retain the branch after a PR is closed or merged. Reset it
    // only after a ref-creation conflict; permission/server errors must surface.
    if(error.status!==422)throw error;
    await gh.json(`${root}/git/ref/heads/${encodeURIComponent(branch)}`);
    if(matches.length) {
      await gh.json(`${root}/git/refs/heads/${encodeURIComponent(branch)}`,{method:'PATCH',body:{sha:commit.sha,force:true}});
    }
  }
  // A new PR gets fresh state, so no closed PR's agent session is resumed.
  return gh.json(`${root}/pulls`,{method:'POST',body:{head:branch,base,title:titleFor(title,'running'),body:render(`Fixes #${issue}`,{version:1,issue},progress),draft:true}});
}
