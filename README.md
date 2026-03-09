# AgentMeter Action

> **⚠️ EXPERIMENTAL — Not ready for general use.**
> This action is under active development and is being tested locally. Do not use it in production workflows. The API surface, inputs, and behavior may change without notice.

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

  - uses: foo-software/agentmeter-action@v1
    if: always()  # Run even if the agent step fails
    with:
      api_key: ${{ secrets.AGENTMETER_API_KEY }}
      status: ${{ steps.agent.outcome }}
      model: claude-sonnet-4-5
```

### With explicit token counts

```yaml
  - uses: foo-software/agentmeter-action@v1
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
  - uses: foo-software/agentmeter-action@v1
    if: always()
    with:
      api_key: ${{ secrets.AGENTMETER_API_KEY }}
      agent_output: ${{ steps.agent.outputs.response }}
      model: claude-sonnet-4-5
```

### With PR number from agent output

```yaml
  - uses: foo-software/agentmeter-action@v1
    if: always()
    with:
      api_key: ${{ secrets.AGENTMETER_API_KEY }}
      status: ${{ steps.agent.outcome }}
      model: claude-sonnet-4-5
      pr_number: ${{ steps.agent.outputs.pr_number }}
```

### Disable comment posting

```yaml
  - uses: foo-software/agentmeter-action@v1
    if: always()
    with:
      api_key: ${{ secrets.AGENTMETER_API_KEY }}
      post_comment: false
```

---

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api_key` | ✅ | — | Your AgentMeter API key (`am_sk_…`). Get it from [agentmeter.app/dashboard/settings](https://agentmeter.app/dashboard/settings). |
| `model` | ❌ | `''` | The AI model used (e.g. `claude-sonnet-4-5`, `claude-opus-4-6`). |
| `engine` | ❌ | `claude` | The AI engine (`claude`, `copilot`, `codex`). |
| `agent_output` | ❌ | `''` | Raw stdout from the agent step. Used to auto-extract token counts from JSON. |
| `input_tokens` | ❌ | `''` | Explicit input token count. Overrides extraction from `agent_output`. |
| `output_tokens` | ❌ | `''` | Explicit output token count. |
| `cache_read_tokens` | ❌ | `''` | Cache read token count. |
| `cache_write_tokens` | ❌ | `''` | Cache write token count. |
| `turns` | ❌ | `''` | Number of agent turns/iterations. |
| `status` | ❌ | `success` | Run status: `success`, `failed`, `timed_out`, `cancelled`, `needs_human`. |
| `pr_number` | ❌ | `''` | PR number created by this run (if any). |
| `api_url` | ❌ | `https://agentmeter.app` | AgentMeter API base URL. Override for self-hosted or testing. |
| `post_comment` | ❌ | `true` | Set to `false` to skip posting a cost comment on the PR/issue. |

---

## Outputs

| Output | Description |
|--------|-------------|
| `run_id` | The AgentMeter run ID (UUID). |
| `total_cost_usd` | Total cost in USD as a decimal string (e.g. `"4.52"`). |
| `dashboard_url` | Link to the run detail page in the AgentMeter dashboard. |

---

## Token data approaches

### Approach A — Pass raw JSON output from the agent step

```yaml
- uses: foo-software/agentmeter-action@v1
  with:
    api_key: ${{ secrets.AGENTMETER_API_KEY }}
    agent_output: ${{ steps.agent.outputs.response }}
```

The action parses the JSON to extract token counts automatically.

### Approach B — Explicit token counts

```yaml
- uses: foo-software/agentmeter-action@v1
  with:
    api_key: ${{ secrets.AGENTMETER_API_KEY }}
    input_tokens: ${{ steps.agent.outputs.input_tokens }}
    output_tokens: ${{ steps.agent.outputs.output_tokens }}
    cache_read_tokens: ${{ steps.agent.outputs.cache_read_tokens }}
    cache_write_tokens: ${{ steps.agent.outputs.cache_write_tokens }}
```

### Approach C — No token data (minimal tracking)

```yaml
- uses: foo-software/agentmeter-action@v1
  with:
    api_key: ${{ secrets.AGENTMETER_API_KEY }}
    status: ${{ steps.agent.outcome }}
```

The run is tracked with zero token data.

---

## PR/issue comment

When the action runs in the context of an issue or PR, it posts (or updates) a cost summary comment:

```
⚡ AgentMeter

| # | Workflow | Status | Cost | Duration |
|---|----------|--------|------|----------|
| 1 | agent-implement | ✅ | $4.52 | — |

<details>
<summary>Token breakdown</summary>

| Type | Tokens | Cost |
|------|--------|------|
| Input | 42,318 | — |
| Output | 18,204 | — |
| Cache writes | 31,000 | — |
| Cache reads | 128,400 | — |

Model: claude-sonnet-4-5 · 14 turns · 75% cache hit rate
</details>

[View in AgentMeter →](https://agentmeter.app/dashboard/runs/abc123)
```

If the action runs again on the same PR/issue, it updates the existing comment (adds a new row) instead of posting a new one.

---

## Important: always use `if: always()`

Place `if: always()` on the AgentMeter step so it runs even when the agent step fails. This ensures failed runs are tracked too.

```yaml
- uses: foo-software/agentmeter-action@v1
  if: always()
  with:
    api_key: ${{ secrets.AGENTMETER_API_KEY }}
    status: ${{ steps.agent.outcome }}
```

---

## Requirements

- Node.js 20 (provided by the GitHub Actions runner)
- A `GITHUB_TOKEN` in the environment (automatically available in every workflow run — no extra config needed for comment posting)
- An AgentMeter API key from [agentmeter.app](https://agentmeter.app)

---

## Development

See [docs/testing.md](docs/testing.md) for instructions on how to test this action locally.

---

## License

MIT — [Foo.software](https://foo.software)
