# AgentMeter Action

> **⚠️ EXPERIMENTAL — Not ready for general use.**
> This action is under active development and is being tested internally. The API surface, inputs, and behavior may change without notice.

Track token usage and cost for AI agent runs in GitHub Actions. Works with Claude Code, GitHub Copilot, and Codex.

[![CI](https://github.com/foo-software/agentmeter-action/actions/workflows/ci.yml/badge.svg)](https://github.com/foo-software/agentmeter-action/actions/workflows/ci.yml)

---

## Overview

Add this action after your AI agent step to:

1. Extract token usage and cost from the agent's output
2. Submit run metadata to the [AgentMeter](https://agentmeter.app) ingest API
3. Post or update a cost summary comment on the triggering PR or issue

The action **never fails your workflow** — all API calls and comment posts use `core.warning()` for errors, not `core.setFailed()`.

---

## Usage

### Minimal — status tracking only

```yaml
steps:
  - uses: anthropics/claude-code-action@v1
    id: agent
    with:
      anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
      prompt: "Implement the feature described in this issue"

  - uses: foo-software/agentmeter-action@main
    if: always()  # Run even if the agent step fails
    with:
      api_key: ${{ secrets.AGENTMETER_API_KEY }}
      status: ${{ steps.agent.outcome }}
      model: claude-sonnet-4-5
```

### With explicit token counts

```yaml
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

### With JSON output from the agent (auto-extraction)

```yaml
  - uses: foo-software/agentmeter-action@main
    if: always()
    with:
      api_key: ${{ secrets.AGENTMETER_API_KEY }}
      agent_output: ${{ steps.agent.outputs.response }}
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

## Usage with gh-aw (GitHub Agent Workflows)

If you use [gh-aw](https://github.github.com/gh-aw/introduction/overview/) to run agents, create a companion workflow that triggers via `workflow_run`. Pass `workflow_run_id` and the action handles everything automatically — gate logic, status normalization, trigger number resolution, and token extraction.

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

The action reads token counts from an `agent-tokens` artifact that your `agent` job must upload. Add these two steps to your `.lock.yml` after the `Execute Claude Code CLI` step:

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

---

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api_key` | ✅ | — | Your AgentMeter API key (`am_sk_…`). Get it from [agentmeter.app/dashboard/settings](https://agentmeter.app/dashboard/settings). |
| `model` | ❌ | `''` | The AI model used (e.g. `claude-sonnet-4-5`). Used for per-token cost display. |
| `engine` | ❌ | `claude` | The AI engine (`claude`, `copilot`, `codex`). |
| `status` | ❌ | `success` | Run status: `success`, `failed`, `timed_out`, `cancelled`, `needs_human`. |
| `agent_output` | ❌ | `''` | Raw stdout from the agent step. Used to auto-extract token counts from JSON. |
| `input_tokens` | ❌ | `''` | Explicit input token count. Overrides extraction from `agent_output`. |
| `output_tokens` | ❌ | `''` | Explicit output token count. |
| `cache_read_tokens` | ❌ | `''` | Cache read token count. |
| `cache_write_tokens` | ❌ | `''` | Cache write token count. |
| `turns` | ❌ | `''` | Number of agent turns/iterations. |
| `pr_number` | ❌ | `''` | PR number created by this run (if any). |
| `workflow_run_id` | ❌ | `''` | Run ID of the triggering agent workflow (`github.event.workflow_run.id`). Enables auto-resolution of tokens, trigger number, timestamps, and gate logic. |
| `started_at` | ❌ | `''` | ISO 8601 start timestamp. Overrides self-measured time. Use `github.event.workflow_run.run_started_at` in companion workflows. |
| `completed_at` | ❌ | `''` | ISO 8601 completion timestamp. Use `github.event.workflow_run.updated_at` in companion workflows. |
| `trigger_number` | ❌ | `''` | Issue or PR number to comment on. Override for `workflow_run` setups where auto-resolution fails. |
| `trigger_event` | ❌ | `''` | Original event name (`issues`, `pull_request`, etc.). Used with `trigger_number`. |
| `post_comment` | ❌ | `true` | Set to `false` to skip posting a cost comment. |
| `api_url` | ❌ | `https://agentmeter.app` | AgentMeter API base URL. Override for local dev or self-hosted. |
| `github_token` | ❌ | `${{ github.token }}` | GitHub token for comment posting and artifact access. Defaults to the built-in token — no config needed. |

---

## Outputs

| Output | Description |
|--------|-------------|
| `run_id` | The AgentMeter run ID (UUID). |
| `total_cost_usd` | Total cost in USD as a decimal string (e.g. `"4.52"`). |
| `dashboard_url` | Link to the run detail page in the AgentMeter dashboard. |

---

## PR/issue comment

When the action runs in the context of an issue or PR, it posts (or updates) a cost summary comment:

```
⚡ AgentMeter

| # | Workflow | Model | Status | Cost | Duration |
|---|----------|-------|--------|------|----------|
| 1 | agent-implement | claude-sonnet-4-5 | ✅ | $4.52 | 18m |

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

If the action runs again on the same PR/issue, it updates the existing comment (adds a new row) instead of posting a new one.

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

- Node.js 24 (provided by the GitHub Actions runner)
- A `GITHUB_TOKEN` (automatically available in every workflow run — no extra config needed for comment posting)
- An AgentMeter API key from [agentmeter.app](https://agentmeter.app)

---

## Data collection and privacy

AgentMeter collects only the following data from each agent run:

| Field | Example |
|---|---|
| Token counts (input, output, cache read/write) | `1024`, `312`, `0`, `0` |
| Run duration | `183` seconds |
| Model name | `claude-haiku-4-5` |
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

## Development

See [docs/testing.md](docs/testing.md) for instructions on how to test this action locally and in CI.

See [docs/challenges.md](docs/challenges.md) for known limitations and caveats.

---

## License

MIT — [Foo.software](https://foo.software)
