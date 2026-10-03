# AFNM Codex Agent

An issue-to-PR GitHub Action for **GPT-6 Luna**, the OpenAI Agents API, and your own ephemeral Linux x64 runners (including Ubicloud). No server or database is required.

## Behavior

- Starts from an issue's `codex` label, `@codex` in an issue or PR comment, or `@codex` in an opening issue body.
- Creates an empty commit and a draft PR **before any agent execution**.
- Uses `[WIP]` while working, removes it on success, and switches to `[ERROR]` on failure.
- Refreshes the top of the PR description every 30 seconds with elapsed time, time since the last agent message, session input/output/total tokens, message count and a workflow link. The latest assistant message replaces the previous one. Human text below the managed block is preserved.
- Automatically responds to submitted `changes_requested` reviews, and to `@codex` in inline review comments and PR discussion comments.
- Reuses **the same durable Agents API session** for the lifetime of the PR. The session ID is stored in an HTML comment in the PR description, not a short-lived Actions artifact. Keep that comment when editing the description.
- Fetches and rebases on the latest PR base before each turn. If there are conflicts, the same agent resolves them and continues the rebase before addressing feedback. An unfinished rebase produces an error, not a ready PR.
- Commits and pushes after completion, using an explicit force-with-lease to avoid overwriting concurrent human pushes. Marks the initial draft ready for review on success. Review and merge remain human actions.
- Fetches all pages of issue comments, PR discussion, reviews and inline review threads, including paths and diff hunks.
- Uses an isolated executor container. GitHub and application API keys stay in the controller. The executor only receives its restricted environment key.

This carries over early PR creation, visible status, saved conversations and follow-up context from the supplied Claude action. It does not port that action's scheduling compiler, MCP suite, SSH signing, image downloader or mandatory agent-team policy.

## Install in the target repository

1. Copy [`examples/codex.yml`](examples/codex.yml) to `.github/workflows/codex.yml` in the repository you want the agent to work on.
2. Replace `ubicloud-standard-2` with your actual existing Linux x64 runner label. The runner must support Docker.
3. Create/install a GitHub App on that repository with **Contents, Issues and Pull requests: read/write**. Add `CODEX_APP_ID` as an Actions variable and `CODEX_APP_PRIVATE_KEY` as an Actions secret. The controller renews installation tokens for runs longer than an hour.
4. Add `OPENAI_API_KEY` as an Actions secret. It needs `api.agents.read`, `api.agents.write`, and `api.responses.write`.
5. Create a separate **environment key** in the OpenAI platform Agents dashboard, belonging to the same project and owner as the application key. Give all other permissions None. Save it as `OPENAI_EXECUTOR_API_KEY`.
6. Pin `Lyeeedar/afnm-codex-agent@main` to the tested commit SHA before broad rollout. Label a small test issue `codex`.

A PAT can be passed through `github-token` instead of App inputs. A normal `GITHUB_TOKEN` may need repository settings to permit PR creation and its pushes generally do not trigger downstream workflows. GitHub App authentication is recommended.

No credentials are placed in the target checkout. Repository install/build/test commands run inside the executor. For private package access or extra build tools, supply an appropriate custom executor image, rather than passing application secrets through to the agent.

## Executor image and cost

By default, the action builds [`executor/Dockerfile`](executor/Dockerfile) on the runner, installing `@openai/codex@alpha` as documented for self-hosted Agents API executors. For a large fleet, **prebuild and cache an image** to avoid reinstalling tools in 50 jobs:

```sh
docker build --build-arg CODEX_VERSION=YOUR_TESTED_VERSION -t ghcr.io/YOUR-ORG/codex-executor:VERSION executor
```

Push it through your normal registry process and configure `executor-image`. The image must have `codex exec-server` as its entrypoint and allow the runner user to work in `/workspace`. The supplied image includes Node 22, git, Python and build-essential. Extend it for your project's dependencies.

Application keys and GitHub credentials are outside the container; the container has no host Docker socket, home directory or controller files mounted. The target repository and `.git` are writable, so use disposable runners. This is workload isolation, not a guarantee against kernel vulnerabilities or hostile repository content.

## Parallelism and continuation

There is no global cap in this action: different issue branches use different Actions concurrency groups and can run 50+ jobs if your runner fleet, GitHub plan and OpenAI limits allow it. The tiny routing job currently uses `ubuntu-latest`; it can also use an appropriate Ubicloud label.

Issue events and events on their resulting PR resolve to the **same branch-based concurrency group**, so they cannot race on a session or force-push over each other. `cancel-in-progress: false` lets active work finish.

GitHub's standard concurrency behavior keeps one active and one pending job per group; newer pending events can replace an older pending job. Every continuation fetches the complete current discussion and all reviews, so a surviving run receives that accumulated feedback. This is not a strict FIFO event queue, and comments arriving after the context snapshot are picked up by the queued continuation. Use an external queue if every individual event must get its own execution.

A durable session maintains historical work with automatic context management; it does not mean every historical token stays verbatim in the active context. Each fresh executor receives the checked-out branch at the same `/workspace` path, plus current GitHub context.

Session IDs are identifiers, not credentials. OpenAI-side session history remains in your API project. Do not delete a session while its PR still needs continuation. Closed PRs are not updated; reopen them to continue.

## Failure behavior

The PR stays visible with `[ERROR]`; send `@codex` to retry against the saved history. The controller cancels an active turn when a run fails and stops the container. An `always()` cleanup step also marks the PR as an error if normal finalization was interrupted.

An event-stream disconnect produces an explicit failure. This version does not silently assume an idle session succeeded, replay missed events, or automatically recreate a missing session. Changes not pushed before a failed run are not retained after the disposable runner dies, although the session retains the investigation history. Abrupt runner loss can prevent even cleanup from updating GitHub; the linked workflow is the authoritative run status.

The base is refreshed at turn start. It may move again during execution; use normal CI and a merge queue to validate the final branch against the current base.

Token usage is best-effort session usage, not a final bill. Missing counts are shown as unknown. Cache writes, compute and other tools are not converted into a speculative dollar total.

## Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `github-app-id`, `github-app-private-key` | empty | App authentication with token renewal |
| `github-token` | empty | Alternative GitHub token |
| `openai-api-key` | required | Controller session/inference API key |
| `openai-executor-api-key` | required | Restricted environment connection key |
| `model` | `gpt-6-luna` | Model for a new session |
| `reasoning-effort` | `medium` | Reasoning for a new session |
| `executor-image` | empty | Prebuilt Docker image; otherwise build locally |
| `codex-version` | `alpha` | npm executor version when building locally |
| `status-interval` | `30` | Description update interval, seconds |
| `timeout-minutes` | `120` | Agent turn timeout; allow extra workflow time for setup/cleanup |

Model and reasoning settings are pinned when a session is created; changing workflow inputs does not rewrite an existing session's configuration.

Outputs: `pr-number`, `pr-url`, `branch`, `session-id`.

Only triggers authored by repository collaborators with write/maintain/admin permission are accepted. Bot triggers are ignored to prevent loops. Fork-head PRs are rejected. Configure branch rules for your normal human review and CI requirements.

## Validation

```sh
npm test
npm run check
```

Tests cover trigger routing, prefixes, description/state preservation, message streams, pagination, key redaction, App JWT signing, and a simulated full lifecycle using real git repositories: early PR creation, branch push, follow-up session reuse and rebasing after main advances. No dependencies or package install are required to run the tests.

A live Agents API run still requires account access, the two API keys, and Docker on the actual Ubicloud runner. The executor/API integration uses documented beta interfaces and should be smoke-tested before a 50-way rollout.

## Official API references

- [Self-hosted executor and key separation](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted)
- [Run and continue durable sessions](https://developers.openai.com/api/docs/guides/agents-api/sessions)
- [Event streams and root turn outcomes](https://developers.openai.com/api/docs/guides/agents-api/sessions/events)
- [Session usage accounting](https://developers.openai.com/api/docs/guides/agents-api/observability)
