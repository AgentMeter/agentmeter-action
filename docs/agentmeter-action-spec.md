# AgentMeter Action — Architecture Reference

> This document describes the current architecture and design decisions of the `foo-software/agentmeter-action` GitHub Action.

---

## Repository structure

```
agentmeter-action/
├── action.yml                    # Action definition — inputs, outputs, runs config
├── src/
│   ├── main.ts                   # Entry point — calls run(), catches unhandled errors
│   ├── run.ts                    # Core orchestration — wires all modules together
│   ├── inputs.ts                 # Parses and validates all action inputs
│   ├── context.ts                # Extracts GitHub Actions context (repo, run ID, trigger, etc.)
│   ├── token-extractor.ts        # Extracts token counts from agent output (JSON then regex)
│   ├── workflow-run.ts           # workflow_run_id auto-resolution (gate, tokens, trigger, timestamps)
│   ├── ingest.ts                 # POSTs run data to the AgentMeter API with retry
│   ├── comment.ts                # Builds and upserts the PR/issue cost comment
│   ├── pricing.ts                # Fetches model pricing from the API with prefix-match fallback
│   └── types.ts                  # Shared TypeScript types
├── dist/
│   └── index.js                  # Compiled + bundled output (committed to repo)
├── __tests__/
│   ├── token-extractor.test.ts
│   ├── context.test.ts
│   ├── ingest.test.ts
│   ├── comment.test.ts
│   ├── workflow-run.test.ts
│   └── pricing.test.ts
├── .github/workflows/
│   ├── ci.yml                          # Lint + type-check + test on every push/PR
│   ├── build.yml                       # Verifies dist/ is not stale on every push/PR
│   ├── agentmeter.yml                  # Companion workflow for workflow_run mode (gh-aw)
│   ├── agentmeter-inline-test.yml      # PR-branch inline test (pull_request trigger)
│   ├── agent-review-codex.yml          # Inline Codex agent review on every PR
│   ├── agent-review.lock.yml           # gh-aw compiled lock file for agent review
│   └── codex-compat-check.yml          # Validates Codex rollout file parsing
└── docs/
    ├── agentmeter-action-spec.md  # This file
    ├── challenges.md              # Known limitations and caveats
    └── testing.md                 # How to test locally and in CI
```

---

## Usage modes

### Mode A — Inline

The action runs as a step in the same workflow as the agent. All GitHub context is available directly. Token counts come from explicit inputs or `agent_output`.

**Supported agents:**
- **Claude Code** (`anthropics/claude-code-action`) — exposes `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, and `turns` as step outputs.
- **Codex** (`openai/codex-action`) — token counts must be extracted from the Codex rollout JSONL file (see [challenges.md](challenges.md#6-codex-token-counts-rely-on-an-internal-rollout-file-format)).
- **Any other agent** — pass explicit `input_tokens` / `output_tokens`, or set `agent_output` to the agent's stdout and let the action attempt JSON extraction.

### Mode B — Companion workflow (`workflow_run`)

The action runs in a separate workflow triggered by `workflow_run: completed`. The `workflow_run_id` input enables automatic resolution of timestamps, trigger number, status normalization, and token extraction from the `agent-tokens` artifact.

See `docs/challenges.md` for known limitations of Mode B.

---

## Key design decisions

### Never fail the workflow

Every API call and comment post uses `core.warning()` for errors, never `core.setFailed()`. A bad API key, network outage, or missing artifact degrades to a no-op and the user's workflow continues.

### Token extraction priority

1. Explicit `input_tokens` / `output_tokens` inputs (overrides on a per-field basis — a partial override only replaces the fields provided)
2. `agent-tokens` artifact from `workflow_run_id` (Mode B)
3. JSON parsing of `agent_output` (looks for `usage` key)
4. Regex fallback on `agent_output` text (marked `isApproximate: true`)
5. No tokens — omitted from payload entirely

Partial explicit overrides (e.g. providing only `input_tokens`) merge with the artifact or extracted values for the remaining fields rather than zeroing them out.

### `workflow_run_id` auto-resolution (`src/workflow-run.ts`)

When set, `resolveWorkflowRun` does four things:

1. **Gate** — calls `listJobsForWorkflowRun` and exits early unless a job named `conclusion` has completed. Prevents ~5 duplicate ingests from gh-aw's multi-job structure. Single-job workflows pass through unconditionally.
2. **Status normalization** — maps GitHub conclusions (`failure` → `failed`, `skipped` → skip entirely) to the AgentMeter API enum. Unrecognized statuses (e.g. custom `needs_human`) pass through unchanged.
3. **Trigger resolution** — reads `pull_requests[]` from the run object; falls back to a `pulls.list` lookup by head branch if empty (GitHub API quirk for some PR-triggered runs). Works for fork PRs (`head` parameter is branch name only, not `owner:branch`).
4. **Token artifact** — downloads and unzips the `agent-tokens` artifact using `fflate`.

### Pricing (`src/pricing.ts`)

`fetchPricing` hits `GET {api_url}/api/models/pricing` (5s timeout). On any failure it returns `{}` and logs an info message. `getPricing` tries an exact (lowercased) match first, then a prefix-based fallback — the longest key in the pricing table that the model ID starts with. This handles versioned or aliased IDs (e.g. `gpt-5.4-mini-20250514` matches `gpt-5.4-mini`). Models without caching support return `null` for `cacheReadPer1M`, which renders as `—` in comments.

### Comment format (`src/comment.ts`)

Comment table columns: `# | Workflow | Model | Status | Cost | Duration`

The upsert logic:
1. Searches for an existing comment with `<!-- agentmeter -->` marker (paginated search)
2. Parses existing rows; supports both old 5-column and current 6-column formats for backward compatibility
3. Appends the new row, shows the 5 most recent runs by default, and wraps older runs in a collapsible `<details>` block
4. Runs are ordered newest-first
5. Updates existing comment or creates a new one

### `githubRunId` in payload

When `workflow_run_id` is provided, `githubRunId` in the ingest payload is set to `workflow_run_id` (the agent's run ID), not `ctx.runId` (the companion workflow's run ID). This ensures the AgentMeter dashboard links to the correct run.

### Trigger type resolution

`context.ts` maps GitHub event names to AgentMeter trigger types. `issue_comment` is correctly classified as `pr_comment` when `payload.issue.pull_request` is present, and `issue_comment` otherwise.

In companion `workflow_run` mode, `resolveTrigger` in `workflow-run.ts` returns a `triggerType` and `triggerRef` that reflect the original triggering event, not the companion workflow's own `workflow_run` event.

---

## Inputs summary

See `action.yml` for the authoritative list. Key inputs:

| Input | Purpose |
|-------|---------|
| `api_key` | AgentMeter API key (required) |
| `workflow_run_id` | Enables Mode B auto-resolution |
| `model` | AI model name (used for pricing and comment) |
| `engine` | `claude` / `codex` |
| `status` | Run outcome passed to API |
| `input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_write_tokens` | Explicit token counts (override extraction per-field) |
| `agent_output` | Raw stdout for auto-extraction |
| `started_at` / `completed_at` | ISO 8601 timestamps (override self-measured) |
| `post_comment` | Whether to upsert a PR/issue comment |
| `api_url` | API base URL (for local dev / self-hosted) |
| `github_token` | Defaults to `${{ github.token }}` — no config needed |

---

## Ingest API

```
POST {api_url}/api/ingest
Authorization: Bearer {api_key}
Content-Type: application/json
```

Response: `{ id, totalCostCents, dashboardUrl }`

One retry on network failure (not on 4xx/5xx). 10s timeout per attempt. Deduplication is handled server-side via `githubRunId`.

---

## Pricing API

```
GET {api_url}/api/models/pricing
```

Response: `{ models: { [modelName]: { inputPerMillionTokens, outputPerMillionTokens, cacheWritePerMillionTokens, cacheReadPerMillionTokens } }, sources: [...] }`

Public, unauthenticated. Cached 1 hour. Used exclusively for comment token cost display. Not required for ingest.
