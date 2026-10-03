// Keep startup bounded for repositories with years of large binary revisions.
// Fetch both current snapshots at depth one, matching the old issue workflow.
// Extend the commit graph with filtered fetches so historical assets stay on GitHub.
export async function fetchForRebase(authGit, git, branch, base, report) {
  const refs = [`+refs/heads/${branch}:refs/remotes/origin/agent`, `+refs/heads/${base}:refs/remotes/origin/base`];
  await report('Fetching the latest branch and base (one commit per tip)…');
  await authGit('fetch', '--quiet', '--depth=1', 'origin', ...refs);
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
