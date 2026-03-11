# Known Challenges with `workflow_run` Integration

When using `agentmeter-action` via a `workflow_run` trigger (the required pattern for tracking gh-aw / multi-job agent workflows), several non-obvious problems arise. This document captures each one, the current workaround, and the ideal fix.

---

## 1. Multiple firings per agent run

### Status: Workaround in place (user-facing)

### Problem

`workflow_run` fires once **per job completion**, not once per workflow completion. gh-aw workflows have 5 jobs (`pre_activation`, `activation`, `agent`, `safe_outputs`, `conclusion`), so a single agent run produces 4–5 `workflow_run` events — and therefore 4–5 potential ingest calls.

### Workaround

Gate on the terminal job. A `Check if conclusion job completed` step calls the GitHub API before doing anything else. If the `conclusion` job hasn't finished yet, all subsequent steps are skipped. This produces exactly 1 ingest call per agent run.

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

This step must remain in the user's companion workflow — it can't be moved into the action itself, because you can't gate a step from inside it. Moving the check inside the action would still burn runner time on 4 no-op runs.

### Better long-term solution

Backend dedup by `(githubRunId, workflowName)` — last-write-wins upsert. This would make the gate step unnecessary and be resilient to edge cases.

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

### Status: Workaround in place (user-facing)

### Problem

`workflow_run.conclusion` can be `skipped` when jobs have unmet `if:` conditions. The AgentMeter API only accepts `running | success | failed | timed_out | cancelled | needs_human`.

### Workaround

A `Normalize conclusion` step maps GitHub conclusions to valid API statuses and marks `skipped` runs for early exit:

```yaml
- name: Normalize conclusion
  id: conclusion
  run: |
    case "${{ github.event.workflow_run.conclusion }}" in
      success)   echo "status=success"   >> "$GITHUB_OUTPUT" ;;
      failure)   echo "status=failed"    >> "$GITHUB_OUTPUT" ;;
      timed_out) echo "status=timed_out" >> "$GITHUB_OUTPUT" ;;
      cancelled) echo "status=cancelled" >> "$GITHUB_OUTPUT" ;;
      skipped)   echo "status=skip"      >> "$GITHUB_OUTPUT" ;;
      *)         echo "status=failed"    >> "$GITHUB_OUTPUT" ;;
    esac
```

### Better long-term solution

Move this normalization into the action itself so the user only passes `status: ${{ github.event.workflow_run.conclusion }}` and the action handles the mapping internally.

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

One-time per deploy. The gate step (challenge #1) limits actual ingest calls to runs where the `conclusion` job was the triggering job, so most of the burst is instant no-ops.

---

## User-facing boilerplate summary

After all the above, the minimum companion `agentmeter.yml` for a gh-aw repo is:

```yaml
on:
  workflow_run:
    workflows: ["Agent: My Workflow"]
    types: [completed]

jobs:
  track:
    runs-on: ubuntu-latest
    permissions:
      actions: read
      issues: write
      pull-requests: write
    steps:
      - name: Check if conclusion job completed  # Challenge #1 workaround
        id: gate
        uses: actions/github-script@v7
        with:
          script: |
            const { data } = await github.rest.actions.listJobsForWorkflowRun({
              owner: context.repo.owner, repo: context.repo.repo,
              run_id: context.payload.workflow_run.id,
            });
            const job = data.jobs.find(j => j.name === 'conclusion');
            core.setOutput('proceed', job?.status === 'completed' ? 'true' : 'false');

      - name: Normalize conclusion  # Challenge #3 workaround
        id: conclusion
        if: steps.gate.outputs.proceed == 'true'
        run: |
          case "${{ github.event.workflow_run.conclusion }}" in
            success)   echo "status=success"   >> "$GITHUB_OUTPUT" ;;
            failure)   echo "status=failed"    >> "$GITHUB_OUTPUT" ;;
            timed_out) echo "status=timed_out" >> "$GITHUB_OUTPUT" ;;
            cancelled) echo "status=cancelled" >> "$GITHUB_OUTPUT" ;;
            *)         echo "status=skip"      >> "$GITHUB_OUTPUT" ;;
          esac

      - name: Track agent run cost
        if: steps.gate.outputs.proceed == 'true' && steps.conclusion.outputs.status != 'skip'
        uses: foo-software/agentmeter-action@main
        with:
          api_key: ${{ secrets.AGENTMETER_API_KEY }}
          engine: claude
          model: ${{ vars.GH_AW_MODEL_AGENT_CLAUDE }}
          status: ${{ steps.conclusion.outputs.status }}
          workflow_run_id: ${{ github.event.workflow_run.id }}  # Handles everything else
          post_comment: 'true'
```

Challenges #2 (trigger number) and #4 (tokens) are fully handled by `workflow_run_id`. Challenges #1 and #3 still require the two pre-steps above.

---

## Summary table

| Challenge | Status | Notes |
|---|---|---|
| 4–5 ingests per agent run | Workaround (user-facing) | Gate step required; ideal fix is backend dedup |
| Missing trigger number | ✅ Solved | Handled by `workflow_run_id` input |
| `skipped` status 422 | Workaround (user-facing) | Normalize step required; could be moved into action |
| First-deploy backfill burst | Accepted | One-time, gate makes it cheap |
| Token data unavailable | ✅ Solved for gh-aw | `workflow_run_id` fetches artifact; other engines use explicit inputs |

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
