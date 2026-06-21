---
name: "Agent: Turns Test"
description: "Manually-triggered agent run to verify turns tracking end-to-end"

engine: claude

on:
  workflow_dispatch:
    inputs:
      branch:
        description: "Branch to check out (defaults to current)"
        required: false
        default: ""

timeout-minutes: 10

permissions:
  contents: read
  pull-requests: read

tools:
  bash: ["cat", "head", "tail", "grep", "wc", "ls", "find", "echo"]
  github:
    toolsets: [repos]

safe-outputs:
  noop:
    max: 1
---

# Turns Test

You are verifying that the AgentMeter action correctly captures agent turn counts.

## Your Task

1. List the files in the root of this repository using `ls`.
2. Count the number of TypeScript source files in `src/` using `find`.
3. Report your findings using `noop` with a brief summary of what you found.

Keep it short. This is a smoke-test to generate a real agent run with a known turn count.
