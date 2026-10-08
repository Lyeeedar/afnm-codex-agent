# AFNM Codex Agent

An issue-to-PR GitHub Action for **GPT-6 Luna**, the OpenAI Agents API, and your own ephemeral Linux x64 runners (including Ubicloud). No server or database is required.

## Behavior

- Starts from an issue's `agent` (or `codex`) label, `@agent` (or `@codex`) in an issue or PR comment, or `@agent` (or `@codex`) in an opening issue body.
- Creates an empty commit and a draft PR **before any agent execution**.
- If an issue's previous Codex PR is closed or merged, starts a new PR and agent session from the latest default branch, resetting the retained `codex/issue-*` branch if needed. Issue triggers resume an existing open PR instead.
- Uses `[WIP]` while working, removes it on success, and switches to `[ERROR]` on failure.
- Refreshes the top of the PR description every 30 seconds with elapsed time, time since the last agent message, session input/output/total tokens, message count and a workflow link. The latest assistant message replaces the previous one. Human text below the managed block is preserved.
- Automatically responds to submitted `changes_requested` reviews, and to `@agent` (or `@codex`) in inline review comments and PR discussion comments.
- Reuses **the same durable Agents API session** for the lifetime of the PR. The session ID is stored in an HTML comment in the PR description, not a short-lived Actions artifact. Keep that comment when editing the description.
- Fetches one commit per branch/base tip initially, matching the old issue workflow, and deepens only when needed to locate a shared ancestor. Deepening uses blob filtering to avoid downloading historical binary revisions. Startup stages are reported in the PR and workflow logs; git operations time out after five minutes.
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

By default, the action restores a cached executor image keyed by OS, architecture, Dockerfile contents and the resolved npm version. On a cache miss it builds [`executor/Dockerfile`](executor/Dockerfile) on the runner and saves the image even if the later agent turn fails, installing `@openai/codex@alpha` as documented for self-hosted Agents API executors. For a large fleet, **prebuild and cache an image** to avoid reinstalling tools in 50 jobs:

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

The PR stays visible with `[ERROR]`; send `@agent` (or `@codex`) to retry against the saved history. The controller cancels an active turn when a run fails and stops the container. An `always()` cleanup step also marks the PR as an error if normal finalization was interrupted.

Event-stream disconnects automatically reconnect up to six times with exponential backoff (1–30 seconds), keeping the same session, executor and working files alive. Following the [Agents API recovery procedure](https://developers.openai.com/api/docs/guides/agents-api/sessions/events#how-to-recover-a-disconnected-stream), the controller subscribes before retrieving saved messages and turn outcomes because streams do not replay missed events. It does not resubmit an accepted task or treat an idle session, a previous turn, or a completed subagent as success. Lost submission responses are retried with the same idempotency key. Confirmed rate-limit failures retain their separate turn retry behavior. Recovery remains bounded by the run timeout; failed sessions, failed or cancelled root turns, executor exits and exhausted reconnects produce explicit errors. Missing sessions are not automatically recreated. Changes not pushed before a failed run are not retained after the disposable runner dies, although the session retains the investigation history. Abrupt runner loss can prevent even cleanup from updating GitHub; the linked workflow is the authoritative run status.

The base is refreshed at turn start. It may move again during execution; use normal CI and a merge queue to validate the final branch against the current base.

PR status and workflow summaries report tokens and estimated USD model cost for each workflow run, with a persisted run history. Accounting reads paginated root and subagent turns, includes rate-limit retries, deduplicates turn IDs, and refreshes late-arriving usage for earlier runs when the PR resumes. Session totals remain separate from run totals. A bounded six-second completion wait gives delayed accounting time to arrive; missing usage remains unknown and partial counts are labeled.

Cost estimates use GPT-6 Luna standard short-context input ($0.10/M), cached input ($0.01/M), and output ($0.50/M) rates verified on 2026-10-03. Reasoning is already included in output. The Agents API does not expose per-call context length or separate cache writes, so estimates exclude cache writes, long-context premiums, tools and runner costs and are not a final bill. Models without a configured rate show unavailable cost rather than using an incorrect price. See the [official pricing](https://developers.openai.com/api/docs/models/gpt-6-luna).

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

Rate-limited agent turns automatically resume the same session and checkout with jittered exponential backoff (30 seconds up to 10 minutes, at most six retries). The PR reports the wait. HTTP retries honor Retry-After; permission, billing and ordinary task failures are not automatically retried.

Task screenshots and save files linked with GitHub `blob` or `raw.githubusercontent.com` URLs are downloaded by the controller before a turn starts. The executor receives a read-only `/agent-input` mount and a manifest mapping URLs to local files; it never receives GitHub credentials. Same-repository private files use the controller token, public cross-repository files need no credentials, and private cross-repository files require the App installed on that repository with Contents read access. Downloads are bounded to 20 files and 32 MiB each. An inaccessible attachment fails early with the actual access error rather than letting the agent silently skip reproduction.

Visual checks run on demand inside the existing executor. The cached image contains Playwright 1.63.0, matching Chromium, fonts, and system libraries. A non-visual task does not start a browser or install game dependencies. The additional browser image layers increase cache transfer/load size. Chromium and its system dependencies are installed when building the image; game dependencies are installed only when a visual check needs them and they are absent from the workspace.

For AFNM, the controller supplies `/opt/agent-preview/start.mjs` and `control.mjs`. The agent starts an isolated renderer, optionally loads a downloaded report save, inspects the actual page/screenshots, and repeats interactions against the same page while Vite updates edited code. This browser adapter covers rendering, settings, and temporary saves; desktop integration still requires Electron validation. Screenshots in `/agent-output` are uploaded automatically as a workflow artifact linked from the PR. The controller excludes runtime preview files from commits and never gives browser tools GitHub credentials.

The preview also supports direct, repeatable state setup without playing through the game:

```sh
node /opt/agent-preview/control.mjs state catalog locations "Sect"
node /opt/agent-preview/control.mjs state apply /workspace/.agent-preview/scenario.json
node /opt/agent-preview/control.mjs state inspect player.player.realm,inventory.money
node /opt/agent-preview/control.mjs state snapshot before-test
node /opt/agent-preview/control.mjs state restore /workspace/.agent-preview/checkpoints/before-test.json
```

For example, `{"base":"fresh","realm":"coreFormation","location":"Shen Henda City","screen":"library","money":100000}` creates a disposable character using the game's existing realm skips, then opens the library. Authored progression presets currently cover Body Forging through Core Formation; later builds should start from real save JSON/checkpoints rather than setting the realm field alone. `base: "current"` preserves the loaded player's state; active activities are cleared only with explicit `clearActivities: true`. Exact names for locations, enemies, items, recipes and techniques are discoverable with `state catalog`. Combat and crafting use `combat: {enemy}` and `crafting: {recipe}`, with the actual game initializers. Arbitrary scenarios can use exact-path `patch` replacements and real action/thunk `operations` (`module`, `export`, `args`). Invalid setup rolls back instead of leaving a partial state, and a mismatched state-derived screen produces an error. Checkpoints stay under `.agent-preview` and are never uploaded as visual evidence. These tools are injected by the preview-only Vite plugin; the shipped game is not changed.

Rebase preparation first fetches shallow branch/base metadata with `blob:none`, then authenticates checkout so only the current working snapshot is downloaded. Git downloads have a fifteen-minute deadline and retry twice on timeouts or transient network failures. Permission errors and merge conflicts are not retried; the existing agent resolves actual rebase conflicts. Pushes retain the explicit lease and are never replayed automatically.

Fresh preview scenarios pause automatic story/tutorial triggers by default. Use `"pauseTriggers": false` to exercise those triggers, or `true` to stabilize a current save while setting up a screen. This adapter is injected only into the agent preview.

Set `github-evidence-repository` to a public screenshot repository such as `Lyeeedar/AscendFromNineMountainsReleases`. Screenshots are published on independent `codex-evidence/pr-*/run-*` branches there and displayed directly in PR reports using immutable public raw image URLs. The GitHub App must have Contents write access to that repository; the controller requests a token scoped to it. These branches contain only collected PNGs and are not merged into the game. Workflow ZIP artifacts remain available as a backup. Inline publishing failures are reported explicitly.

