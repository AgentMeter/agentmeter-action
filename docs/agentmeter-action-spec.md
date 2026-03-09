# AgentMeter Action — Build Specification

> This document is the complete spec for building the `agentmeter/agentmeter-action` GitHub Action.
> It contains everything an agent needs to implement the Action from scratch.

---

## Overview

The AgentMeter GitHub Action is a TypeScript GitHub Action that:

1. Runs after an AI coding agent (Claude Code, Copilot, Codex) completes
2. Extracts token usage and cost from the agent's output
3. Submits run metadata to the AgentMeter ingest API
4. Posts or updates a cost summary comment on the triggering PR or issue

The Action lives in a **separate repository**: `foo-software/agentmeter-action`.

---

## Repository structure

```
agentmeter-action/
├── action.yml                  # Action definition — inputs, outputs, runs config
├── src/
│   ├── main.ts                 # Entry point
│   ├── run.ts                  # Core run logic (orchestrates all steps)
│   ├── inputs.ts               # Parse and validate GitHub Action inputs
│   ├── context.ts              # Extract GitHub Actions context (repo, run ID, trigger, etc.)
│   ├── token-extractor.ts      # Parse token data from agent output
│   ├── ingest.ts               # POST to AgentMeter API
│   ├── comment.ts              # Post/update GitHub PR/issue comment
│   └── types.ts                # TypeScript types
├── dist/
│   └── index.js                # Compiled + bundled output (committed to repo)
├── __tests__/
│   ├── token-extractor.test.ts
│   ├── ingest.test.ts
│   └── comment.test.ts
├── package.json
├── tsconfig.json
├── .gitignore
└── README.md
```

---

## `action.yml` definition

```yaml
name: 'AgentMeter'
description: 'Track token usage and cost for AI agent runs in GitHub Actions'
author: 'Foo.software'
branding:
  icon: 'zap'
  color: 'green'

inputs:
  api_key:
    description: 'Your AgentMeter API key (from agentmeter.app/dashboard/settings/general)'
    required: true
  model:
    description: 'The AI model used (e.g. claude-sonnet-4-5, claude-opus-4-6)'
    required: false
    default: ''
  engine:
    description: 'The AI engine used (claude, copilot, codex). Defaults to claude.'
    required: false
    default: 'claude'
  agent_output:
    description: 'Stdout from the agent step (for JSON token extraction). Pass using ${{ steps.agent.outputs.response }} or similar.'
    required: false
    default: ''
  input_tokens:
    description: 'Input token count (if known; overrides extraction from agent_output)'
    required: false
    default: ''
  output_tokens:
    description: 'Output token count (if known; overrides extraction from agent_output)'
    required: false
    default: ''
  cache_read_tokens:
    description: 'Cache read token count'
    required: false
    default: ''
  cache_write_tokens:
    description: 'Cache write token count'
    required: false
    default: ''
  turns:
    description: 'Number of agent turns/iterations (if known)'
    required: false
    default: ''
  status:
    description: 'Run status: success, failed, timed_out, cancelled, needs_human. Defaults to success.'
    required: false
    default: 'success'
  pr_number:
    description: 'PR number created by this run (if any)'
    required: false
    default: ''
  api_url:
    description: 'AgentMeter API base URL (override for self-hosted or testing)'
    required: false
    default: 'https://agentmeter.app'
  post_comment:
    description: 'Whether to post a cost comment on the PR/issue. Set to false to disable.'
    required: false
    default: 'true'

outputs:
  run_id:
    description: 'The AgentMeter run ID (UUID)'
  total_cost_usd:
    description: 'Total cost in USD as a decimal string (e.g. "4.52")'
  dashboard_url:
    description: 'Link to the run detail page in AgentMeter dashboard'

runs:
  using: 'node20'
  main: 'dist/index.js'
```

---

## Inputs specification

### Required

- **`api_key`** — The user's AgentMeter API key. Begins with `am_sk_`. This is their org-level API key from the dashboard. The Action passes this as `Authorization: Bearer {api_key}` to the ingest API.

### Token data inputs (choose one approach)

**Approach A — Pass raw JSON output from the agent step:**
```yaml
- uses: anthropics/claude-code-action@v1
  id: agent
  with:
    prompt: "..."
    output_format: json  # if supported

- uses: agentmeter/agentmeter-action@v1
  with:
    api_key: ${{ secrets.AGENTMETER_API_KEY }}
    agent_output: ${{ steps.agent.outputs.response }}
```
The Action parses this JSON to extract token counts (see token extraction section).

**Approach B — Explicit token counts:**
```yaml
- uses: agentmeter/agentmeter-action@v1
  with:
    api_key: ${{ secrets.AGENTMETER_API_KEY }}
    input_tokens: ${{ steps.agent.outputs.input_tokens }}
    output_tokens: ${{ steps.agent.outputs.output_tokens }}
    cache_read_tokens: ${{ steps.agent.outputs.cache_read_tokens }}
    cache_write_tokens: ${{ steps.agent.outputs.cache_write_tokens }}
```

**Approach C — No token data (minimal):**
```yaml
- uses: agentmeter/agentmeter-action@v1
  with:
    api_key: ${{ secrets.AGENTMETER_API_KEY }}
    status: ${{ steps.agent.outcome }}
```
The run is tracked with zero token data. `isApproximate` will be `false` and tokens will be 0.

---

## GitHub Actions context extraction

The Action reads standard GitHub Actions environment variables and the `@actions/github` context object. No special permissions are required beyond the defaults.

```typescript
// From @actions/github
const context = github.context;

// What to extract:
const repoFullName = `${context.repo.owner}/${context.repo.repo}`;
const githubRunId  = context.runId;                          // number
const workflowName = context.workflow;                       // string
const eventName    = context.eventName;                      // "issues", "pull_request", "issue_comment", etc.
const payload      = context.payload;

// Map eventName → triggerType
const triggerType  = mapEventToTriggerType(eventName, payload);

// Extract triggerRef and triggerNumber
const { triggerRef, triggerNumber } = extractTriggerRef(eventName, payload);

// startedAt: use Date.now() at the beginning of the Action
// completedAt: use Date.now() at the end
```

### Trigger type mapping

```typescript
function mapEventToTriggerType(eventName: string, payload: WebhookPayload): string {
  if (eventName === 'issues') {
    const action = payload.action;
    if (action === 'labeled') return 'issue_labeled';
    return 'other';
  }
  if (eventName === 'pull_request') {
    const action = payload.action;
    if (action === 'opened') return 'pr_opened';
    if (action === 'synchronize') return 'pr_synchronize';
    return 'other';
  }
  if (eventName === 'issue_comment' || eventName === 'pull_request_review_comment') {
    return 'pr_comment';
  }
  if (eventName === 'schedule') return 'schedule';
  if (eventName === 'workflow_dispatch') return 'workflow_dispatch';
  return 'other';
}
```

### Trigger ref extraction

```typescript
function extractTriggerRef(
  eventName: string,
  payload: WebhookPayload
): { triggerRef: string | null; triggerNumber: number | null } {
  // Issues
  if (eventName === 'issues' && payload.issue) {
    return {
      triggerRef: `#${payload.issue.number}`,
      triggerNumber: payload.issue.number,
    };
  }
  // Pull requests
  if ((eventName === 'pull_request' || eventName === 'pull_request_review_comment') && payload.pull_request) {
    return {
      triggerRef: `PR #${payload.pull_request.number}`,
      triggerNumber: payload.pull_request.number,
    };
  }
  // Issue comments — could be on an issue or a PR
  if (eventName === 'issue_comment' && payload.issue) {
    const isPR = !!payload.issue.pull_request;
    return {
      triggerRef: isPR ? `PR #${payload.issue.number}` : `#${payload.issue.number}`,
      triggerNumber: payload.issue.number,
    };
  }
  return { triggerRef: null, triggerNumber: null };
}
```

---

## Token extraction from agent output

Claude Code Action can output a JSON result when run with `--output-format json`. The structure varies by Claude Code version. The Action should attempt extraction gracefully and fall back to zeros.

### Claude Code JSON output structure (best-effort parsing)

```typescript
interface ClaudeCodeOutput {
  // Top-level fields (structure may vary)
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  // Some versions nest under result
  result?: {
    usage?: { /* same */ };
  };
  // Some versions have cost_usd directly
  cost_usd?: number;
}
```

```typescript
function extractTokensFromOutput(
  agentOutput: string
): { tokens: TokenCounts; isApproximate: boolean } | null {
  if (!agentOutput) return null;

  try {
    // Try to parse as JSON directly
    const parsed = JSON.parse(agentOutput) as ClaudeCodeOutput;
    const usage = parsed.usage ?? parsed.result?.usage;

    if (usage) {
      return {
        tokens: {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
        },
        isApproximate: false,
      };
    }
  } catch {
    // Not valid JSON — try to extract from text using regex
  }

  // Fallback: regex-based extraction from stdout text
  // Claude Code sometimes prints token counts in human-readable form
  const inputMatch = agentOutput.match(/input[_\s]tokens?:\s*(\d+)/i);
  const outputMatch = agentOutput.match(/output[_\s]tokens?:\s*(\d+)/i);

  if (inputMatch || outputMatch) {
    return {
      tokens: {
        inputTokens: inputMatch ? parseInt(inputMatch[1] ?? '0', 10) : 0,
        outputTokens: outputMatch ? parseInt(outputMatch[1] ?? '0', 10) : 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      isApproximate: true, // Regex extraction is not precise
    };
  }

  return null; // No token data found
}
```

### Priority order for token data

1. Explicit `input_tokens`/`output_tokens` inputs (if provided)
2. Extracted from `agent_output` JSON
3. Extracted from `agent_output` text (approximate)
4. Zeros with `isApproximate: false` (no data available)

---

## Ingest API call

### Endpoint

```
POST https://agentmeter.app/api/ingest
Authorization: Bearer {api_key}
Content-Type: application/json
```

### Request body

This must match the `runIngestSchema` from `packages/shared/src/schemas/run.ts`:

```typescript
{
  githubRunId: number;          // context.runId
  repoFullName: string;         // "owner/repo"
  workflowName: string;         // context.workflow
  triggerType: string;          // see trigger type mapping above
  triggerRef: string | null;    // "#45" or "PR #38" or null
  triggerNumber: number | null; // 45 or 38 or null
  engine: string;               // "claude" (default), "copilot", "codex"
  model: string | null;         // "claude-sonnet-4-5" or null
  status: string;               // "success", "failed", "timed_out", "cancelled", "needs_human"
  prNumber: number | null;      // PR created by this run, if any
  durationSeconds: number | null; // elapsed time in seconds
  turns: number | null;         // agent iteration count, if known
  startedAt: string;            // ISO 8601 — recorded when Action starts
  completedAt: string;          // ISO 8601 — recorded when Action ends
  tokens?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    isApproximate: boolean;
  };
}
```

### Response

```typescript
{
  id: string;             // AgentMeter run UUID
  totalCostCents: number; // Calculated cost in integer cents
  dashboardUrl: string;   // "https://agentmeter.app/dashboard/runs/{id}"
}
```

### Error handling

The Action **must not fail the workflow** if the API call fails. Always use `try/catch` and log errors with `core.warning()`, not `core.setFailed()`.

```typescript
try {
  const result = await submitToAgentMeter(payload);
  core.setOutput('run_id', result.id);
  core.setOutput('total_cost_usd', (result.totalCostCents / 100).toFixed(2));
  core.setOutput('dashboard_url', result.dashboardUrl);
  return result;
} catch (error) {
  core.warning(`AgentMeter ingest failed: ${error}. Continuing.`);
  return null;
}
```

### Retry policy

Make one retry on network failure (not on 4xx/5xx responses from the API):

```typescript
async function fetchWithRetry(url: string, options: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  } catch {
    // One retry after 2 seconds
    await new Promise(r => setTimeout(r, 2000));
    return fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  }
}
```

---

## GitHub comment posting

### Authentication

Use the `GITHUB_TOKEN` that GitHub Actions provides automatically. This is the default token in every workflow run. Request it via `@actions/github`:

```typescript
const octokit = github.getOctokit(process.env.GITHUB_TOKEN!);
```

No additional permissions beyond the default `contents: read` are needed — GitHub's default token has `issues: write` and `pull-requests: write` for the repo.

### Comment identity

The comment is posted as the `github-actions[bot]` user (via `GITHUB_TOKEN`). To find an existing AgentMeter comment to update, search for a comment body that contains a unique marker:

```typescript
const COMMENT_MARKER = '<!-- agentmeter -->';
```

Always include this HTML comment (invisible in rendered Markdown) at the top of the comment body.

### Finding the right issue/PR to comment on

```typescript
async function findOrCreateComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueOrPrNumber: number
): Promise<number | null> {
  try {
    // List existing comments
    const comments = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueOrPrNumber,
      per_page: 100,
    });

    // Find existing AgentMeter comment
    const existing = comments.data.find(c => c.body?.includes(COMMENT_MARKER));
    return existing?.id ?? null;
  } catch {
    return null;
  }
}
```

### Comment format

The comment body should be a Markdown string. Use the `COMMENT_MARKER` at the top so we can find and update it later.

For the first run on a PR/issue:
```markdown
<!-- agentmeter -->
## ⚡ AgentMeter

| Workflow | Status | Cost | Duration | Model |
|----------|--------|------|----------|-------|
| agent-implement | ✅ | $4.52 | 18m | claude-sonnet-4-5 |

<details>
<summary>Token breakdown</summary>

| Type | Tokens | Cost |
|------|--------|------|
| Input | 42,318 | $0.13 |
| Output | 18,204 | $0.27 |
| Cache writes | 31,000 | $0.12 |
| Cache reads | 128,400 | $0.04 |

14 turns · 75% cache hit rate
</details>

[View in AgentMeter →](https://agentmeter.app/dashboard/runs/abc123)
```

For subsequent runs (updating the existing comment), add a new row to the table and update the total row. The Action receives the `dashboardUrl` from the API response for the "View in AgentMeter" link.

### Status emoji mapping

| Status | Emoji |
|--------|-------|
| `success` | ✅ |
| `failed` | ❌ |
| `timed_out` | ⏱ |
| `cancelled` | 🚫 |
| `needs_human` | 👤 |
| `running` | ⏳ |

### Posting/updating the comment

```typescript
async function upsertComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueOrPrNumber: number,
  body: string
): Promise<void> {
  try {
    const existingId = await findOrCreateComment(octokit, owner, repo, issueOrPrNumber);

    if (existingId) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existingId,
        body,
      });
    } else {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueOrPrNumber,
        body,
      });
    }
  } catch (error) {
    core.warning(`Failed to post comment: ${error}`);
  }
}
```

---

## Build and bundle

GitHub Actions require a single compiled file in `dist/index.js`. Use `@vercel/ncc` to bundle:

```json
// package.json scripts
{
  "build": "tsc && ncc build dist/main.js -o dist --minify",
  "prepare": "npm run build"
}
```

The `dist/` directory must be **committed to the repository**. When a workflow uses `uses: agentmeter/agentmeter-action@v1`, GitHub checks out the repo at that tag and runs `dist/index.js`.

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "strict": true,
    "esModuleInterop": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": false
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "__tests__"]
}
```

### Dependencies

```json
{
  "dependencies": {
    "@actions/core": "^1.10.1",
    "@actions/github": "^6.0.0"
  },
  "devDependencies": {
    "@types/node": "^20",
    "@vercel/ncc": "^0.38.1",
    "typescript": "^5.4.0",
    "vitest": "^1.0.0"
  }
}
```

Do not add unnecessary dependencies. The bundle must be fast to load in a GitHub Actions runner.

---

## Full usage examples

### Minimal — status tracking only

```yaml
steps:
  - uses: anthropics/claude-code-action@v1
    id: agent
    with:
      anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
      prompt: "Implement the feature described in this issue"

  - uses: agentmeter/agentmeter-action@v1
    if: always()  # Run even if agent step fails
    with:
      api_key: ${{ secrets.AGENTMETER_API_KEY }}
      status: ${{ steps.agent.outcome }}  # "success" or "failure"
      model: claude-sonnet-4-5
```

### With explicit token counts

```yaml
steps:
  - uses: anthropics/claude-code-action@v1
    id: agent
    with:
      anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
      prompt: "..."

  - uses: agentmeter/agentmeter-action@v1
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

### With PR number output from agent

```yaml
steps:
  - uses: anthropics/claude-code-action@v1
    id: agent
    with:
      anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
      prompt: "..."

  - uses: agentmeter/agentmeter-action@v1
    if: always()
    with:
      api_key: ${{ secrets.AGENTMETER_API_KEY }}
      status: ${{ steps.agent.outcome }}
      model: claude-sonnet-4-5
      pr_number: ${{ steps.agent.outputs.pr_number }}
```

### No comment posting

```yaml
  - uses: agentmeter/agentmeter-action@v1
    if: always()
    with:
      api_key: ${{ secrets.AGENTMETER_API_KEY }}
      post_comment: false
```

---

## Main entry point

```typescript
// src/main.ts
import * as core from '@actions/core';
import { run } from './run';

run().catch((error) => {
  // Only use setFailed for unexpected errors in our own logic — not API failures
  core.setFailed(error instanceof Error ? error.message : String(error));
});
```

```typescript
// src/run.ts
import * as core from '@actions/core';
import * as github from '@actions/github';
import { parseInputs } from './inputs';
import { extractContext } from './context';
import { extractTokensFromOutput } from './token-extractor';
import { submitRun } from './ingest';
import { upsertComment } from './comment';
import type { TokenCounts } from './types';

export async function run(): Promise<void> {
  const startedAt = new Date().toISOString();

  const inputs = parseInputs();
  const ctx = extractContext();

  // Determine token data
  let tokens: (TokenCounts & { isApproximate: boolean }) | undefined;
  let isApproximate = false;

  if (inputs.inputTokens !== null) {
    // Explicit override from inputs
    tokens = {
      inputTokens: inputs.inputTokens,
      outputTokens: inputs.outputTokens ?? 0,
      cacheReadTokens: inputs.cacheReadTokens ?? 0,
      cacheWriteTokens: inputs.cacheWriteTokens ?? 0,
      isApproximate: false,
    };
  } else if (inputs.agentOutput) {
    // Extract from agent output
    const extracted = extractTokensFromOutput(inputs.agentOutput);
    if (extracted) {
      tokens = { ...extracted.tokens, isApproximate: extracted.isApproximate };
    }
  }

  const completedAt = new Date().toISOString();

  // Submit to AgentMeter
  const result = await submitRun({
    apiUrl: inputs.apiUrl,
    apiKey: inputs.apiKey,
    payload: {
      githubRunId: ctx.runId,
      repoFullName: ctx.repoFullName,
      workflowName: ctx.workflowName,
      triggerType: ctx.triggerType,
      triggerRef: ctx.triggerRef,
      triggerNumber: ctx.triggerNumber,
      engine: inputs.engine,
      model: inputs.model,
      status: inputs.status,
      prNumber: inputs.prNumber,
      durationSeconds: Math.round(
        (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000
      ),
      turns: inputs.turns,
      startedAt,
      completedAt,
      tokens,
    },
  });

  if (result) {
    core.setOutput('run_id', result.id);
    core.setOutput('total_cost_usd', (result.totalCostCents / 100).toFixed(2));
    core.setOutput('dashboard_url', result.dashboardUrl);

    // Post comment if enabled and there's a trigger ref
    if (inputs.postComment && ctx.triggerNumber !== null) {
      const octokit = github.getOctokit(process.env['GITHUB_TOKEN'] ?? '');
      await upsertComment({
        octokit,
        owner: ctx.owner,
        repo: ctx.repo,
        issueOrPrNumber: ctx.triggerNumber,
        runData: {
          workflowName: ctx.workflowName,
          status: inputs.status,
          totalCostCents: result.totalCostCents,
          tokens,
          model: inputs.model,
          turns: inputs.turns,
          dashboardUrl: result.dashboardUrl,
        },
      });
    }
  }
}
```

---

## Testing the Action

### Unit tests

Use Vitest. Mock `@actions/core` and `@actions/github`:

```typescript
// __tests__/token-extractor.test.ts
import { describe, it, expect } from 'vitest';
import { extractTokensFromOutput } from '../src/token-extractor';

describe('extractTokensFromOutput', () => {
  it('parses valid JSON output', () => {
    const output = JSON.stringify({
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 100,
      },
    });
    const result = extractTokensFromOutput(output);
    expect(result).not.toBeNull();
    expect(result!.tokens.inputTokens).toBe(1000);
    expect(result!.isApproximate).toBe(false);
  });

  it('returns null for empty output', () => {
    expect(extractTokensFromOutput('')).toBeNull();
  });

  it('returns approximate data for text output', () => {
    const output = 'Completed. Input tokens: 5000, Output tokens: 2000';
    const result = extractTokensFromOutput(output);
    expect(result?.isApproximate).toBe(true);
  });
});
```

### Integration testing

To test the full Action locally before publishing:
```bash
# Set env vars the Action reads from
export INPUT_API_KEY="am_sk_your_key"
export INPUT_MODEL="claude-sonnet-4-5"
export INPUT_STATUS="success"
export GITHUB_REPOSITORY="adam/test-repo"
export GITHUB_RUN_ID="12345678"
export GITHUB_WORKFLOW="agent-implement"
export GITHUB_EVENT_NAME="issues"
export GITHUB_EVENT_PATH="/tmp/event.json"  # JSON file with the event payload
export GITHUB_TOKEN="your_github_pat"

# Run the compiled action
node dist/index.js
```

---

## Publishing to GitHub Marketplace

1. Create a GitHub release with a semver tag: `v1.0.0`
2. Add a description and release notes
3. Check "Publish this Action to GitHub Marketplace" in the release UI
4. The `action.yml` must be at the root of the repo
5. The `branding` section in `action.yml` is required for Marketplace listing

The initial listing should be under the `foo-software` GitHub organization.

---

## Key constraints

1. **Never fail the workflow.** Every API call and comment post must be wrapped in try/catch. The Action uses `core.warning()` for recoverable errors, never `core.setFailed()` unless there's a bug in the Action's own code.

2. **`GITHUB_TOKEN` is always available** — do not ask users to pass a separate token for comment posting. The default token has all necessary permissions.

3. **No API calls in the constructor or at import time** — all network calls happen inside the `run()` function so they can be properly caught.

4. **The `dist/` directory must be committed** — this is the GitHub Actions convention. Add a CI workflow that builds and commits `dist/` on push to `main`.

5. **Keep the bundle small** — avoid large dependencies. The Action should load in under 1 second. Prefer `node-fetch` over `axios`; prefer the built-in `fetch` (Node 18+) where possible.

6. **`if: always()`** — users must put this on the AgentMeter step so it runs even when the agent step fails. Document this clearly in the README.

7. **Backward compatible inputs** — never remove or rename inputs in a minor version. Add new inputs with defaults.
