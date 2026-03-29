# AgentMeter Action

Visibility into what your AI agents actually cost. Works with **Claude Code**, **Codex**, and any agent that outputs token counts.

> **⚠️ Early Access** — AgentMeter is live at [agentmeter.app](https://agentmeter.app) but actively evolving. Core ingest, dashboard, and PR comment features are stable. Some features are still in progress (budget alerts, CSV export, runs table filters). The API surface may change without notice.

[![CI](https://github.com/foo-software/agentmeter-action/actions/workflows/ci.yml/badge.svg)](https://github.com/foo-software/agentmeter-action/actions/workflows/ci.yml)

---

## What it does

[GitHub Agentic Workflows](https://github.github.com/gh-aw/) let AI agents implement issues, review PRs, and respond to comments autonomously — but every agent run consumes tokens and costs money. AgentMeter tracks that spend so you're never surprised.

Add this action after your AI agent step to:

1. Record token usage, model, duration, and status for each agent run
2. Submit the data to the [AgentMeter](https://agentmeter.app) dashboard
3. Post or update a cost summary comment on the triggering PR or issue

The action **never fails your workflow** — all API calls and comment posts use `core.warning()` for errors, not `core.setFailed()`.

---

## Quickstart

### 1. Sign up at agentmeter.app

Go to [agentmeter.app](https://agentmeter.app) and sign in with GitHub. AgentMeter uses GitHub OAuth — no separate account needed.

### 2. Get your API key

After signing in, go to **Settings → API Key** to generate your `am_sk_…` key.

### 3. Add it as a repository secret

In your repo: **Settings → Secrets and variables → Actions → New repository secret**

Name: `AGENTMETER_API_KEY`
Value: your `am_sk_…` key

### 4. Add the action to your workflow

```yaml
- uses: foo-software/agentmeter-action@main
  if: always()
  with:
    api_key: ${{ secrets.AGENTMETER_API_KEY }}
    status: ${{ steps.agent.outcome }}
    model: claude-sonnet-4-5
```

That's it. The action will record the run and post a cost comment on the PR or issue.

---

## Usage examples

There are two ways to use this action:

- **Inline** — the AgentMeter step runs in the same workflow as the agent. Token counts are passed directly as inputs. Simpler, and works for Claude Code and Codex.
- **Companion (`workflow_run`)** — the AgentMeter action lives in a separate workflow that triggers when the agent workflow completes. Required when the agent runs in its own workflow (e.g. gh-aw). The action auto-resolves timestamps, trigger number, and token counts from an artifact.

The examples below are inline. See [Companion `workflow_run` mode](#companion-workflow_run-mode) for the other pattern.

### Claude Code — inline

```yaml
steps:
  - uses: anthropics/claude-code-action@v1
    id: agent
    with:
      anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
      prompt: "Implement the feature described in this issue"

  - uses: foo-software/agentmeter-action@main
    if: always()
    with:
      api_key: ${{ secrets.AGENTMETER_API_KEY }}
      status: ${{ steps.agent.outcome }}
      model: claude-sonnet-4-5
      input_tokens: ${{ steps.agent.outputs.input_tokens }}
      output_tokens: ${{ steps.agent.outputs.output_tokens }}
      cache_read_tokens: ${{ steps.agent.outputs.cache_read_tokens }}
      cache_write_tokens: ${{ steps.agent.outputs.cache_write_tokens }}
      turns: ${{ steps.agent.outputs.turns }}
```

### Codex — inline

```yaml
steps:
  - uses: openai/codex-action@v1
    id: codex
    with:
      openai-api-key: ${{ secrets.OPENAI_API_KEY }}
      prompt: "Review this PR for correctness and style"
      model: gpt-5.4-mini

  - uses: foo-software/agentmeter-action@main
    if: always()
    with:
      api_key: ${{ secrets.AGENTMETER_API_KEY }}
      engine: codex
      model: gpt-5.4-mini
      status: ${{ job.status == 'success' && 'success' || 'failed' }}
```

This records the run with status and duration. Cost will show as `—` because `openai/codex-action` doesn't expose token counts as step outputs.

**To get per-run cost**, add a token extraction step before AgentMeter. Set `codex-home` so the rollout file path is predictable, then parse it:

```yaml
  - uses: openai/codex-action@v1
    id: codex
    with:
      openai-api-key: ${{ secrets.OPENAI_API_KEY }}
      prompt: "Review this PR for correctness and style"
      model: gpt-5.4-mini
      codex-home: /tmp/codex-home   # required for token extraction

  - name: Extract Codex token usage
    id: codex-tokens
    if: always()
    run: |
      rollout=$(find /tmp/codex-home/sessions -name "rollout-*.jsonl" 2>/dev/null -printf "%T@ %p\n" | sort -rn | head -1 | cut -d' ' -f2-)
      token_line=$(grep '"token_count"' "$rollout" 2>/dev/null | tail -1)
      echo "input_tokens=$(echo "$token_line" | jq -r '.payload.info.total_token_usage.input_tokens // empty')" >> "$GITHUB_OUTPUT"
      echo "output_tokens=$(echo "$token_line" | jq -r '.payload.info.total_token_usage.output_tokens // empty')" >> "$GITHUB_OUTPUT"
      echo "cache_read_tokens=$(echo "$token_line" | jq -r '.payload.info.total_token_usage.cached_input_tokens // empty')" >> "$GITHUB_OUTPUT"

  - uses: foo-software/agentmeter-action@main
    if: always()
    with:
      api_key: ${{ secrets.AGENTMETER_API_KEY }}
      engine: codex
      model: gpt-5.4-mini
      status: ${{ job.status == 'success' && 'success' || 'failed' }}
      input_tokens: ${{ steps.codex-tokens.outputs.input_tokens }}
      output_tokens: ${{ steps.codex-tokens.outputs.output_tokens }}
      cache_read_tokens: ${{ steps.codex-tokens.outputs.cache_read_tokens }}
```

> **Note:** Token extraction reads an internal Codex rollout file — not a public API. See [docs/challenges.md](docs/challenges.md#6-codex-token-counts-rely-on-an-internal-rollout-file-format) for caveats.

### Status tracking only (no token counts)

```yaml
- uses: foo-software/agentmeter-action@main
  if: always()
  with:
    api_key: ${{ secrets.AGENTMETER_API_KEY }}
    status: ${{ steps.agent.outcome }}
    model: claude-sonnet-4-5
```

### Disable comment posting

```yaml
- uses: foo-software/agentmeter-action@main
  if: always()
  with:
    api_key: ${{ secrets.AGENTMETER_API_KEY }}
    post_comment: false
```

---

## Companion `workflow_run` mode

The examples above are **inline** — the AgentMeter step runs in the same workflow as the agent and token counts are passed directly as inputs. That's the simplest setup and works for Claude Code and Codex.

If your agent runs in a **separate workflow** (common with [gh-aw](https://github.github.com/gh-aw/introduction/overview/)), use the companion `workflow_run` pattern instead. The AgentMeter action lives in its own workflow that triggers when the agent workflow completes. Set `workflow_run_id` and it handles everything automatically — status normalization, trigger number resolution, timestamps, and token extraction from an artifact the agent job uploads.

### Prerequisites

1. **`AGENTMETER_API_KEY` secret** — add at `github.com/<your-org>/<repo>/settings/secrets/actions`
2. **`actions: read` permission** — required for the action to call the GitHub API internally (list jobs, download artifacts)
3. **`GITHUB_TOKEN`** — automatically available in every workflow run. No extra config needed.

### Companion workflow

```yaml
# .github/workflows/agentmeter.yml
name: AgentMeter — Track Agent Costs

on:
  workflow_run:
    workflows:
      - "Agent: Implement Issue"
      - "Agent: Code Review"
      # add all your gh-aw agent workflow names here
    types:
      - completed

jobs:
  track:
    runs-on: ubuntu-latest
    permissions:
      actions: read        # required — lets the action gate on the conclusion job
      contents: read
      issues: write        # required — lets the action post cost comments
      pull-requests: write
    steps:
      - uses: foo-software/agentmeter-action@main
        with:
          api_key: ${{ secrets.AGENTMETER_API_KEY }}
          engine: claude
          model: ${{ vars.GH_AW_MODEL_AGENT_CLAUDE }}
          status: ${{ github.event.workflow_run.conclusion }}
          workflow_run_id: ${{ github.event.workflow_run.id }}
```

When `workflow_run_id` is set the action internally:

- **Gates** on the `conclusion` job completing (gh-aw fires `workflow_run` ~5 times per agent run — once per job)
- **Normalizes** `failure` → `failed`, skips `skipped` runs entirely
- **Resolves** the PR or issue number from the triggering run
- **Fetches** the `agent-tokens` artifact for token counts

### Token data in gh-aw lock files

The action reads token counts from an `agent-tokens` artifact uploaded by the agent job. You need to add these two steps to your `.lock.yml` after the agent execution step. They must be re-added any time you recompile with `gh aw compile` (since compilation regenerates the lock file):

```yaml
- name: Extract Claude token usage
  id: extract_tokens
  if: always()
  run: |
    RESULT_LINE=$(grep -m1 '"type":"result"' /tmp/gh-aw/agent-stdio.log 2>/dev/null || true)
    if [ -n "$RESULT_LINE" ]; then
      INPUT=$(echo "$RESULT_LINE" | jq -r '.usage.input_tokens // 0')
      OUTPUT=$(echo "$RESULT_LINE" | jq -r '.usage.output_tokens // 0')
      CACHE_READ=$(echo "$RESULT_LINE" | jq -r '.usage.cache_read_input_tokens // 0')
      CACHE_WRITE=$(echo "$RESULT_LINE" | jq -r '.usage.cache_creation_input_tokens // 0')
    else
      INPUT=0; OUTPUT=0; CACHE_READ=0; CACHE_WRITE=0
    fi
    printf '{"input_tokens":%s,"output_tokens":%s,"cache_read_tokens":%s,"cache_write_tokens":%s}\n' \
      "$INPUT" "$OUTPUT" "$CACHE_READ" "$CACHE_WRITE" > /tmp/gh-aw/agent-tokens.json

- name: Upload token data
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: agent-tokens
    path: /tmp/gh-aw/agent-tokens.json
    if-no-files-found: warn
```

> **Note:** `.lock.yml` files are auto-generated by `gh aw compile`. You'll need to re-add these steps after each recompile.

### Token data — other agents (non-gh-aw)

If you're not using gh-aw, add these two steps to your agent job to write and upload the token artifact. The companion workflow picks it up automatically via `workflow_run_id`.

```yaml
# In your agent workflow job — after the agent step
- name: Write token counts
  if: always()
  run: |
    printf '{"input_tokens":%s,"output_tokens":%s,"cache_read_tokens":%s,"cache_write_tokens":%s}\n' \
      "$INPUT_TOKENS" "$OUTPUT_TOKENS" "$CACHE_READ_TOKENS" "$CACHE_WRITE_TOKENS" \
      > /tmp/agent-tokens.json

- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: agent-tokens
    path: /tmp/agent-tokens.json
```

Replace `$INPUT_TOKENS` etc. with however your agent exposes token counts (step outputs, env vars, parsed log lines).

---

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api_key` | ✅ | — | Your AgentMeter API key (`am_sk_…`). Get it from [agentmeter.app/dashboard/settings](https://agentmeter.app/dashboard/settings). |
| `model` | ❌ | `''` | The AI model used (e.g. `claude-sonnet-4-5`). Used for per-token cost display. |
| `engine` | ❌ | `claude` | The AI engine (`claude`, `codex`). |
| `status` | ❌ | `success` | Run outcome. In companion `workflow_run` mode this is resolved automatically from the triggering workflow's conclusion. In inline mode pass `${{ steps.agent.outcome }}` or a custom value like `needs_human`. See [docs/status-values.md](docs/status-values.md). |
| `agent_output` | ❌ | `''` | Raw stdout from the agent step. Used to auto-extract token counts from JSON. |
| `input_tokens` | ❌ | `''` | Explicit input token count. Overrides extraction from `agent_output`. |
| `output_tokens` | ❌ | `''` | Explicit output token count. |
| `cache_read_tokens` | ❌ | `''` | Cache read token count. |
| `cache_write_tokens` | ❌ | `''` | Cache write token count. |
| `turns` | ❌ | `''` | Number of agent turns/iterations. |
| `pr_number` | ❌ | `''` | PR number created by this run (if any). |
| `workflow_run_id` | ❌ | `''` | Run ID of the triggering agent workflow (`github.event.workflow_run.id`). Enables auto-resolution of tokens, trigger number, timestamps, and gate logic. |
| `started_at` | ❌ | `''` | ISO 8601 start timestamp. Overrides self-measured time. |
| `completed_at` | ❌ | `''` | ISO 8601 completion timestamp. |
| `trigger_number` | ❌ | `''` | Issue or PR number to comment on. Override when auto-resolution fails. |
| `trigger_event` | ❌ | `''` | Original event name (`issues`, `pull_request`, etc.). Used with `trigger_number`. |
| `post_comment` | ❌ | `true` | Set to `false` to skip posting a cost comment. |
| `api_url` | ❌ | `https://agentmeter.app` | AgentMeter API base URL. Override for local dev or self-hosted. |
| `github_token` | ❌ | `${{ github.token }}` | GitHub token for comment posting and artifact access. No config needed. |

---

## Outputs

| Output | Description |
|--------|-------------|
| `run_id` | The AgentMeter run ID (UUID). |
| `total_cost_usd` | Total cost in USD as a decimal string (e.g. `"4.52"`). |
| `dashboard_url` | Link to the run detail page in the AgentMeter dashboard. |

---

## PR/issue comment

When the action runs in the context of a PR or issue, it posts (or updates) a cost summary comment:

```
⚡ AgentMeter

| # | Workflow | Model | Status | Cost | Duration |
|---|----------|-------|--------|------|----------|
| 1 | Agent: Code Review | claude-sonnet-4-5 | ✅ | $0.44 | 5m |

▶ Token breakdown

| Type | Tokens | Cost |
|------|--------|------|
| Input | 42,318 | $0.13 |
| Output | 18,204 | $0.27 |
| Cache writes | 31,000 | $0.12 |
| Cache reads | 128,400 | $0.04 |

Model: claude-sonnet-4-5 · 14 turns · 75% cache hit rate

[View in AgentMeter →](https://agentmeter.app/dashboard/runs/abc123)
```

If the action runs again on the same PR/issue, it updates the existing comment (adds a new row) rather than posting a new one. The 5 most recent runs are shown by default; older runs collapse into a "All N runs" toggle.

---

## Important: always use `if: always()`

Place `if: always()` on the AgentMeter step so it runs even when the agent step fails. This ensures failed runs are tracked too.

```yaml
- uses: foo-software/agentmeter-action@main
  if: always()
  with:
    api_key: ${{ secrets.AGENTMETER_API_KEY }}
    status: ${{ steps.agent.outcome }}
```

---

## Requirements

- Node.js 24 (provided by the GitHub Actions runner — no setup needed)
- A `GITHUB_TOKEN` (automatically available in every workflow — no extra config needed)
- An AgentMeter API key from [agentmeter.app](https://agentmeter.app)

**Data retention:** Free tier keeps run data for 30 days. Pro tier keeps data for 90 days.

---

## Data collection and privacy

AgentMeter collects only the following data from each agent run:

| Field | Example |
|---|---|
| Token counts (input, output, cache read/write) | `1024`, `312`, `0`, `0` |
| Run duration | `183` seconds |
| Model name | `claude-sonnet-4-5` |
| Workflow name | `Agent: Implement Issue` |
| GitHub run ID | `22867758493` |
| Repository name | `my-org/my-repo` |
| PR or issue number | `42` |
| Run status | `success` |

AgentMeter does **not** collect or transmit:

- Agent conversation content (prompts, responses, reasoning)
- Code diffs or file contents
- Repository secrets or environment variables
- Any data beyond what is listed above

For gh-aw integrations using `workflow_run_id`: the action downloads a small JSON artifact (`agent-tokens.json`) containing only the four integer token counts. The full agent log never leaves the runner.

---

## AgentMeter dashboard

After runs are ingested, view them at [agentmeter.app/dashboard](https://agentmeter.app/dashboard):

- **Runs feed** — paginated list with cost, status, model, duration, and workflow name per run
- **Run detail** — token breakdown, related runs grouped by the same PR or issue, dashboard link in PR comments
- **Trends** (Pro) — spend over time with breakdowns by workflow, engine, and repo
- **Team** (Pro + GitHub Org) — invite team members with ADMIN or MEMBER roles; manage access from Settings
- **Settings** — API key management, connected repos, plan and billing

---

## Development

See [docs/testing.md](docs/testing.md) for instructions on how to test this action locally and in CI.

See [docs/challenges.md](docs/challenges.md) for known limitations and caveats.

---

## License

MIT — [Foo.software](https://foo.software)
