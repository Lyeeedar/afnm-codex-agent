// Keep startup bounded for repositories with years of large binary revisions.
// Fetch both tips together, then extend history only if their merge base is absent.
export async function fetchForRebase(authGit, git, branch, base, report) {
  const refs = [`+refs/heads/${branch}:refs/remotes/origin/agent`, `+refs/heads/${base}:refs/remotes/origin/base`];
  await report('Fetching the latest branch and base (64 commits of history)…');
  await authGit('fetch', '--quiet', '--depth=64', 'origin', ...refs);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await git('merge-base', 'refs/remotes/origin/agent', 'refs/remotes/origin/base');
      return;
    } catch {
      if (await git('rev-parse', '--is-shallow-repository') !== 'true') {
        throw new Error('The PR branch and base have no shared git history');
      }
      if (attempt === 4) throw new Error('Could not find a merge base within bounded history. Rebase this long-lived branch manually before retrying.');
      const amount = 256 * 2 ** attempt;
      await report(`Fetching ${amount} additional commits to locate the rebase merge base…`);
      await authGit('fetch', '--quiet', `--deepen=${amount}`, 'origin', ...refs);
    }
  }
}
