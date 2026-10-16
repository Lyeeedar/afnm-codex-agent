import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {retryGitTransfer} from './git-retry.mjs';
const exec=promisify(execFile);

// Keep startup bounded for repositories with years of large binary revisions.
// Fetch both current snapshots at depth one, matching the old issue workflow.
// Extend the commit graph with filtered fetches so historical assets stay on GitHub.
export async function fetchForRebase(authGit, git, branch, base, report) {
  const refs = [`+refs/heads/${branch}:refs/remotes/origin/agent`, `+refs/heads/${base}:refs/remotes/origin/base`];
  await report('Fetching current branch/base commit metadata (without historical game assets)…');
  await authGit('fetch', '--quiet', '--depth=1', '--filter=blob:none', 'origin', ...refs);
  for (let attempt = 0; attempt < 9; attempt++) {
    try {
      await git('merge-base', 'refs/remotes/origin/agent', 'refs/remotes/origin/base');
      return;
    } catch {
      if (await git('rev-parse', '--is-shallow-repository') !== 'true') {
        throw new Error('The PR branch and base have no shared git history');
      }
      if (attempt === 8) throw new Error('Could not find a merge base within bounded history. Rebase this long-lived branch manually before retrying.');
      const amount = 2 ** (attempt + 1);
      await report(`Fetching ${amount} additional commits to locate the rebase merge base…`);
      await authGit('fetch', '--quiet', '--filter=blob:none', `--deepen=${amount}`, 'origin', ...refs);
    }
  }
}
// Translation blobs can exceed the normal command-output budget. Size blob
// reads from Git's byte count, while keeping other command output bounded.
export async function gitOutput(args,options={}) {
  const config=['-c','core.hooksPath=/dev/null'];
  // Authentication is prepended as command-local config. Apply it to the size
  // probe too, since cat-file may itself fetch a missing partial-clone blob.
  let command=0;
  while(args[command]==='-c' && command+1<args.length) {
    config.push(args[command],args[command+1]);command+=2;
  }
  const commandArgs=args.slice(command);
  let maxBuffer=options.maxBuffer ?? 8*1024*1024;
  if(commandArgs.length===2 && commandArgs[0]==='show' && /^[^:]+:.+/.test(commandArgs[1])) {
    const {stdout}=await exec('git',[...config,'cat-file','-s',commandArgs[1]],{...options,maxBuffer});
    const bytes=Number(stdout.trim());
    if(!Number.isSafeInteger(bytes) || bytes<0)throw new Error('Invalid Git blob size');
    maxBuffer=Math.max(maxBuffer,bytes+1);
  }
  return (await exec('git',[...config,...commandArgs],{...options,maxBuffer})).stdout.trim();
}

// Partial-clone reads (including diff/show) can fetch missing objects. Give every
// controller command fresh, process-local auth, without persisting it for the executor.
export function createAuthenticatedGit(runGit,getToken,report) {
  return async(...args)=>{
    const operation=async()=>{
      const token=await getToken();
      return runGit('-c',`http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,...args);
    };
    return args.includes('push') ? operation() : retryGitTransfer(operation,report);
  };
}
