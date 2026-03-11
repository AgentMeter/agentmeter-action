# Known Challenges with `workflow_run` Integration

When using `agentmeter-action` via a `workflow_run` trigger (the required pattern for tracking gh-aw / multi-job agent workflows), several non-obvious problems arise. This document captures each one, the current status, and the solution.

---

## 1. Multiple firings per agent run

### Status: ✅ Solved — handled automatically inside the action

### Problem

`workflow_run` fires once **per job completion**, not once per workflow completion. gh-aw workflows have 5 jobs (`pre_activation`, `activation`, `agent`, `safe_outputs`, `conclusion`), so a single agent run produces 4–5 `workflow_run` events — and therefore 4–5 potential ingest calls.

### Solution

When `workflow_run_id` is provided, the action calls `listJobsForWorkflowRun` internally and checks whether the terminal `conclusion` job has completed. If it hasn't, the action exits immediately and skips ingestion. This produces exactly 1 ingest call per agent run.

If the API call fails (e.g. a non-gh-aw workflow that has no `conclusion` job), the gate is bypassed and ingestion proceeds — fail-open rather than fail-closed.

---

## 2. Missing trigger number (issue/PR)

### Status: ✅ Solved — handled automatically inside the action

### Problem

When a workflow fires via `workflow_run`, `github.context` reflects the *AgentMeter workflow's* event — not the original issue or PR that triggered the agent. So the action cannot extract `triggerNumber` from context automatically.

### Solution

Pass `workflow_run_id: ${{ github.event.workflow_run.id }}` to the action. When set, the action calls `getWorkflowRun` internally and extracts the trigger number from:

1. `pull_requests[]` array — populated for PR-triggered workflows
2. Branch name pattern (`agent/issue-N`) — the naming convention used by gh-aw

No user-facing pre-steps required.

---

## 3. `skipped` is not a valid ingest status

### Status: ✅ Solved — handled automatically inside the action

### Problem

`workflow_run.conclusion` can be `skipped` when jobs have unmet `if:` conditions. The AgentMeter API only accepts `running | success | failed | timed_out | cancelled | needs_human`.

### Solution

When `workflow_run_id` is provided, the action normalizes the raw conclusion value internally:

| GitHub conclusion | AgentMeter status |
|---|---|
| `success` | `success` |
| `failure` | `failed` |
| `timed_out` | `timed_out` |
| `cancelled` | `cancelled` |
| `skipped` | *(skipped — nothing to track)* |
| anything else | `failed` |

Users pass `status: ${{ github.event.workflow_run.conclusion }}` raw — no normalization step needed.

---

## 4. Token data unavailable from agent runs

### Status: ✅ Solved for gh-aw — other engines need explicit inputs

### Problem

The action can't observe another workflow's Claude API responses directly. Token counts must come from somewhere.

### Solution (gh-aw)

gh-aw's compiled workflows write an `agent-tokens.json` artifact containing the four token counts extracted from Claude Code's `stream-json` output. When `workflow_run_id` is provided, the action:

1. Lists artifacts for the triggering run
2. Downloads `agent-tokens` as a zip
3. Parses the JSON in-memory (no tmp files, no shell steps)
4. Uses the counts directly

Zero user-facing config required beyond `workflow_run_id`.

### Other engines

- **Custom workflows (any engine):** pass `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` as explicit inputs — callers have this data in code.
- **Fully managed agents (GitHub Copilot coding agent, etc.):** no custom workflow YAML exists; token data not currently accessible. Cost will show as `—` in the dashboard.

---

## 5. First-deploy backfill burst

### Status: Expected behavior — no action needed

### Problem

When a `workflow_run` workflow is first pushed, GitHub retroactively triggers it for all recently-completed matching workflows. This causes a burst of ~15-20 runs within seconds of the initial deploy.

### Notes

One-time per deploy. The gate (challenge #1) limits actual ingest calls to runs where the `conclusion` job was the triggering job, so most of the burst is instant no-ops.

---

## Minimum companion workflow (gh-aw)

With all challenges solved inside the action, the full companion `agentmeter.yml` is:

```yaml
name: AgentMeter — Track Agent Costs

on:
  workflow_run:
    workflows:
      - "Agent: My Workflow"
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

---

## Summary table

| Challenge | Status | Notes |
|---|---|---|
| 4–5 ingests per agent run | ✅ Solved | Action gates on `conclusion` job via `workflow_run_id` |
| Missing trigger number | ✅ Solved | Action resolves from run API via `workflow_run_id` |
| `skipped` status 422 | ✅ Solved | Action normalizes conclusion internally via `workflow_run_id` |
| First-deploy backfill burst | Accepted | One-time; gate makes it cheap |
| Token data unavailable | ✅ Solved for gh-aw | Action fetches `agent-tokens` artifact via `workflow_run_id` |

---

## Security and data collection

The action only ever receives:

- **Token counts** (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`) — integers
- **Run metadata**: GitHub run ID, repo name, workflow name, PR/issue number, model name, status, duration

It does **not** receive or transmit:

- Agent conversation content
- Prompts or instructions
- Code diffs or file contents
- Repository secrets or environment variables

For gh-aw specifically: the `agent-tokens.json` artifact contains only the four integer token counts extracted from Claude Code's output — not the conversation log itself. The full `agent-stdio.log` never leaves the runner.
