# Known Challenges with `workflow_run` Integration

When using `agentmeter-action` via a `workflow_run` trigger (the required pattern for tracking gh-aw / multi-job agent workflows), several non-obvious problems arise. This document captures each one and the workaround applied.

---

## 1. Multiple firings per agent run

### Problem

`workflow_run` fires once **per job completion**, not once per workflow completion. gh-aw workflows have 5 jobs (`pre_activation`, `activation`, `agent`, `safe_outputs`, `conclusion`), so a single agent run produces 4–5 AgentMeter workflow runs — and therefore 4–5 ingest calls.

### Workaround

Gate on the terminal job. Before doing anything, call the GitHub API to check whether the `conclusion` job in the triggering workflow has completed. Skip all subsequent steps if it hasn't.

```yaml
- name: Check if conclusion job completed
  id: gate
  uses: actions/github-script@v7
  with:
    script: |
      const { data } = await github.rest.actions.listJobsForWorkflowRun({
        owner: context.repo.owner,
        repo: context.repo.repo,
        run_id: context.payload.workflow_run.id,
      });
      const conclusionJob = data.jobs.find(j => j.name === 'conclusion');
      core.setOutput('proceed', conclusionJob?.status === 'completed' ? 'true' : 'false');
```

All subsequent steps use `if: steps.gate.outputs.proceed == 'true'`.

### Better long-term solution

`agentmeter-action` could accept a `github_run_id` override and the backend could deduplicate ingests by `(githubRunId, workflowName)` — last-write-wins or idempotent upsert. This would make the gate step unnecessary and be more resilient to race conditions.

---

## 2. Missing trigger number (issue/PR)

### Problem

When a workflow fires via `workflow_run`, `github.context` reflects the *AgentMeter workflow's* event — not the original issue or PR that triggered the agent. So `context.ts` in the action cannot extract the `triggerNumber` automatically.

### Workaround

Add a pre-step that resolves the trigger number from the `workflow_run` payload using three fallbacks in priority order:

1. `github.event.workflow_run.pull_requests[]` — populated for PR-triggered workflows
2. Branch name pattern match (`agent/issue-N`) — the naming convention used by gh-aw
3. GitHub API lookup for an open PR with the triggering head branch

Pass the resolved values as explicit inputs:

```yaml
trigger_number: ${{ steps.trigger.outputs.number }}
trigger_event: ${{ steps.trigger.outputs.event_name }}
post_comment: ${{ steps.trigger.outputs.number != '' }}
```

The action's `run.ts` prefers these overrides over context extraction when present.

### Better long-term solution

`agentmeter-action` could expose a `resolve_trigger` mode that performs this lookup internally, removing the need for a separate pre-step in every caller's workflow. Alternatively, the action could accept a raw `workflow_run_id` and resolve everything itself.

---

## 3. `skipped` is not a valid ingest status

### Problem

`workflow_run.conclusion` can be `skipped` (when jobs have unmet `if:` conditions), but the AgentMeter API only accepts `running | success | failed | timed_out | cancelled | needs_human`. Passing `skipped` directly results in a 422.

### Workaround

Add a normalization step before the action:

```yaml
- name: Normalize conclusion
  id: conclusion
  run: |
    case "${{ github.event.workflow_run.conclusion }}" in
      success)   echo "status=success"   >> "$GITHUB_OUTPUT" ;;
      failure)   echo "status=failed"    >> "$GITHUB_OUTPUT" ;;
      timed_out) echo "status=timed_out" >> "$GITHUB_OUTPUT" ;;
      cancelled) echo "status=cancelled" >> "$GITHUB_OUTPUT" ;;
      skipped)   echo "status=skip"      >> "$GITHUB_OUTPUT" ;;  # handled below
      *)         echo "status=failed"    >> "$GITHUB_OUTPUT" ;;
    esac
```

Skip the track step entirely for `skipped` runs (`if: steps.conclusion.outputs.status != 'skip'`) — a skipped run has no tokens to record.

### Better long-term solution

The action itself could accept and silently no-op on `skipped`, or the API could add `skipped` to its enum (mapping it to `cancelled` internally). Either removes the need for a manual normalization step.

---

## 4. One-time backfill burst on first deploy

### Problem

When a `workflow_run` workflow is first pushed to a branch/main, GitHub retroactively triggers it for all recently-completed matching workflows. This caused ~18 AgentMeter workflow runs to fire within seconds of the initial deploy.

### Notes

This is expected GitHub behavior and is a one-time event per deploy. No workaround needed — just be aware that the first deploy will produce a burst of runs, most of which will fail (or warn) if the ingest endpoint isn't ready.

The gate from challenge #1 limits the actual ingest calls to only the ones where the `conclusion` job was the triggering job, so most of the burst is no-ops.

---

## 5. Token data unavailable from gh-aw agent runs

### Problem

gh-aw agent workflows run Claude Code internally but do not expose the Claude API response (which contains `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`) as a step output. The `agentmeter-action` has full support for extracting tokens from agent stdout via `agent_output`, but there is no way to capture that output from within a `workflow_run` trigger — the triggering workflow's step outputs are not accessible.

As a result, the `tokens` field is omitted from every ingest payload sent from evenloop, and cost shows as `—` in the dashboard.

### Workaround

None currently. The `tokens` field is correctly omitted rather than sending zeroes (which would record a $0.00 cost incorrectly).

### Better long-term solution

gh-aw needs to expose the agent's token usage as a job output or step summary. Concretely, the `agent` job in each `.lock.yml` would need to capture Claude Code's JSON output and set it as an output variable, e.g.:

```yaml
- name: Run agent
  id: agent
  run: claude ... --output-format json > agent_output.json
- name: Set token outputs
  run: |
    cat agent_output.json | jq -r '.usage.input_tokens' | xargs -I{} echo "input_tokens={}" >> $GITHUB_OUTPUT
    # etc.
```

Then the `agentmeter.yml` companion workflow could read those outputs via the GitHub API (`listJobsForWorkflowRun` → step outputs) and pass them as explicit inputs to the action.

Alternatively, AgentMeter could query the GitHub API directly for the triggering run's job logs and attempt to parse token data from them — though log parsing is fragile.

---

## Summary table

| Challenge | Current workaround | Ideal fix |
|---|---|---|
| 4–5 ingests per agent run | Gate on `conclusion` job via API call | Backend dedup by `githubRunId` |
| Missing trigger number | Pre-step with 3-tier fallback resolution | Action resolves internally from `workflow_run_id` |
| `skipped` status 422 | Normalize + skip step | API accepts `skipped` or action no-ops it |
| First-deploy backfill burst | Accepted / no action | N/A — GitHub behavior |
| Token data not available | Omit `tokens` field (cost shows `—`) | gh-aw exposes Claude usage as job outputs |
