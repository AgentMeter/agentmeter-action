# Status Values

Documents how the `status` input works in the AgentMeter Action and what values are valid.

---

## How status is determined

### Companion workflow mode (`workflow_run` trigger)

When `workflow_run_id` is set, status is resolved **automatically** from the GitHub Actions conclusion of the triggering workflow. The user does not need to pass `status` — the action reads it from the `workflow_run` event payload and normalizes it internally via `normalizeConclusion()`.

```yaml
- uses: foo-software/agentmeter-action@main
  with:
    api_key: ${{ secrets.AGENTMETER_API_KEY }}
    workflow_run_id: ${{ github.event.workflow_run.id }}
    # status is resolved automatically — no need to set it
```

### Inline mode (direct / same-workflow)

When running inline (no `workflow_run_id`), the user passes `status` explicitly. It defaults to `'success'` if omitted.

```yaml
- uses: foo-software/agentmeter-action@main
  if: always()
  with:
    api_key: ${{ secrets.AGENTMETER_API_KEY }}
    status: ${{ steps.agent.outcome }}
```

---

## Built-in GitHub conclusion mappings

`normalizeConclusion()` maps GitHub's standard conclusion strings to AgentMeter's internal status enum:

| GitHub conclusion | AgentMeter status | Notes |
|---|---|---|
| `success` | `success` | |
| `failure` | `failed` | |
| `timed_out` | `timed_out` | |
| `cancelled` | `cancelled` | |
| `skipped` | *(not ingested)* | Run is skipped entirely — nothing is sent to the API |

**Source of truth:** `normalizeConclusion()` in `src/workflow-run.ts`.

---

## Custom statuses

Any value **not** in the mapping table above is passed through to the API unchanged. This is intentional — unrecognized values are preserved so custom statuses are not silently replaced with `failed`.

### `needs_human`

The primary custom status. Use it when an agent run completes but requires human review before the result can be acted on (e.g. low-confidence output, a tool call was blocked, or the agent explicitly flagged escalation).

**Example — conditionally set based on an agent output flag:**

```yaml
- uses: anthropics/claude-code-action@v1
  id: agent
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    prompt: "..."

- uses: foo-software/agentmeter-action@main
  if: always()
  with:
    api_key: ${{ secrets.AGENTMETER_API_KEY }}
    model: claude-sonnet-4-5
    status: ${{ steps.agent.outputs.needs_human == 'true' && 'needs_human' || job.status }}
```

When `steps.agent.outputs.needs_human` is `'true'`, the run is recorded as `needs_human`. Otherwise it falls back to the job's actual status (`success` or `failure`).

---

## All valid AgentMeter status values

| Value | Set via action | Description |
|---|---|---|
| `success` | ✅ | Agent run completed successfully |
| `failed` | ✅ | Agent run failed |
| `timed_out` | ✅ | Agent run exceeded its time limit |
| `cancelled` | ✅ | Agent run was cancelled |
| `needs_human` | ✅ | Run completed but requires human review |
| `running` | ❌ internal only | Run is currently in progress — not settable via action |
