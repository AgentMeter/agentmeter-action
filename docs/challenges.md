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

gh-aw agent workflows run Claude Code internally but do not expose the Claude API response (which contains `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`) as a step output. The `agentmeter-action` has full support for extracting tokens from agent stdout via `agent_output`, but there is no way to capture that output from within a `workflow_run` trigger — the triggering workflow's step outputs are not accessible via the GitHub REST API (`listJobsForWorkflowRun` only returns step status/timing, not outputs).

As a result, the `tokens` field is omitted from every ingest payload sent from the calling workflow, and cost shows as `—` in the dashboard.

### Workaround

Patch the `agent` job in each generated `.lock.yml` to:

1. Parse Claude Code's `--output-format stream-json` output (already written to `/tmp/gh-aw/agent-stdio.log`) to extract the `"type":"result"` line, which contains the full usage block.
2. Write the counts to `$GITHUB_OUTPUT` and to a JSON file.
3. Upload the JSON file as a GitHub Actions artifact named `agent-tokens`.
4. Expose the four values as job-level outputs.

```yaml
- name: Extract Claude token usage
  id: extract_tokens
  if: always()
  run: |
    RESULT_LINE=$(grep -m1 '"type":"result"' /tmp/gh-aw/agent-stdio.log 2>/dev/null || true)
    if [ -n "$RESULT_LINE" ]; then
      INPUT=$(echo "$RESULT_LINE" | jq -r '.usage.input_tokens // 0' 2>/dev/null || echo "0")
      OUTPUT=$(echo "$RESULT_LINE" | jq -r '.usage.output_tokens // 0' 2>/dev/null || echo "0")
      CACHE_READ=$(echo "$RESULT_LINE" | jq -r '.usage.cache_read_input_tokens // 0' 2>/dev/null || echo "0")
      CACHE_WRITE=$(echo "$RESULT_LINE" | jq -r '.usage.cache_creation_input_tokens // 0' 2>/dev/null || echo "0")
    else
      INPUT=0; OUTPUT=0; CACHE_READ=0; CACHE_WRITE=0
    fi
    {
      echo "input_tokens=$INPUT"
      echo "output_tokens=$OUTPUT"
      echo "cache_read_tokens=$CACHE_READ"
      echo "cache_write_tokens=$CACHE_WRITE"
    } >> "$GITHUB_OUTPUT"
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

In the companion `agentmeter.yml`, download the artifact using the triggering run's ID (requires `actions: read` permission), parse the JSON, and pass the values as explicit inputs:

```yaml
- name: Download token data
  id: download_tokens
  if: steps.gate.outputs.proceed == 'true'
  continue-on-error: true
  uses: actions/download-artifact@v4
  with:
    name: agent-tokens
    run-id: ${{ github.event.workflow_run.id }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    path: /tmp/agent-tokens

- name: Parse token data
  id: tokens
  if: steps.gate.outputs.proceed == 'true'
  run: |
    if [ -f /tmp/agent-tokens/agent-tokens.json ]; then
      echo "input_tokens=$(jq -r '.input_tokens // 0' /tmp/agent-tokens/agent-tokens.json)" >> "$GITHUB_OUTPUT"
      echo "output_tokens=$(jq -r '.output_tokens // 0' /tmp/agent-tokens/agent-tokens.json)" >> "$GITHUB_OUTPUT"
      echo "cache_read_tokens=$(jq -r '.cache_read_tokens // 0' /tmp/agent-tokens/agent-tokens.json)" >> "$GITHUB_OUTPUT"
      echo "cache_write_tokens=$(jq -r '.cache_write_tokens // 0' /tmp/agent-tokens/agent-tokens.json)" >> "$GITHUB_OUTPUT"
    else
      echo "input_tokens=" >> "$GITHUB_OUTPUT"
      echo "output_tokens=" >> "$GITHUB_OUTPUT"
      echo "cache_read_tokens=" >> "$GITHUB_OUTPUT"
      echo "cache_write_tokens=" >> "$GITHUB_OUTPUT"
    fi

- name: Track agent run cost
  uses: foo-software/agentmeter-action@main
  with:
    # ... other inputs ...
    input_tokens: ${{ steps.tokens.outputs.input_tokens }}
    output_tokens: ${{ steps.tokens.outputs.output_tokens }}
    cache_read_tokens: ${{ steps.tokens.outputs.cache_read_tokens }}
    cache_write_tokens: ${{ steps.tokens.outputs.cache_write_tokens }}
```

#### Important: lock files are regenerated on `gh aw compile`

The `.lock.yml` files are auto-generated by `gh aw compile` from the `.md` workflow sources. Any manual patches are **wiped on the next compile**. To reapply, keep a patch script in your repo (e.g. `scripts/patch-lock-token-outputs.py`) and run it after every compile. The script should use the unique two-line sequence `MCP_TOOL_TIMEOUT: 60000\n      - name: Configure Git credentials` as the insertion anchor — this appears exactly once per file, immediately after the `agentic_execution` step.

### Better long-term solution

gh-aw should natively expose Claude Code's token usage as a job output or step summary, eliminating the need to patch generated files. Until then, the artifact approach above is the most reliable option — `actions/download-artifact@v4` with `run-id` is a stable, documented cross-workflow artifact transfer pattern.

---

## Summary table

| Challenge | Current workaround | Ideal fix |
|---|---|---|
| 4–5 ingests per agent run | Gate on `conclusion` job via API call | Backend dedup by `githubRunId` |
| Missing trigger number | Pre-step with 3-tier fallback resolution | Action resolves internally from `workflow_run_id` |
| `skipped` status 422 | Normalize + skip step | API accepts `skipped` or action no-ops it |
| First-deploy backfill burst | Accepted / no action | N/A — GitHub behavior |
| Token data not available | Patch lock files to extract + upload artifact; download in agentmeter.yml | gh-aw exposes Claude usage as native job outputs |
