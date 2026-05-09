# Code Subtask Bootstrap Template

Use this template whenever a new code subtask is created for this project.

## Purpose

Reduce repeated repository re-discovery.
Force each code subtask to begin from the shared navigation index instead of scanning the whole tree again.

## Enforcement Model

This template is enforced operationally in two ways:

1. The parent planning task keeps the rule in its TODO and subtask sequencing policy.
2. Every future [`new_task`](functions.new_task) launch message should copy the launcher block from this file instead of writing a fresh ad-hoc prompt.

What this can guarantee:

- the parent task can guarantee that **its own** future [`new_task`](functions.new_task) calls are constructed from this template
- the launch prompt will explicitly instruct the child code task to read [`docs/project-structure-overview.md`](hermes-web-ui/docs/project-structure-overview.md) first

What this cannot absolutely guarantee:

- no independent child model can be forced at a system level to obey a markdown document with 100 percent certainty

So the practical guarantee is process-level rather than kernel-level:

- fixed launcher text
- fixed startup rule
- parent-task review before each new child task is launched

## Required First Step

Before reading implementation files, first read:

- [`docs/project-structure-overview.md`](hermes-web-ui/docs/project-structure-overview.md)

Treat it as the initial navigation index.

## Subtask Startup Rules

1. Read [`docs/project-structure-overview.md`](hermes-web-ui/docs/project-structure-overview.md) first
2. From that document, identify the minimum file set for the current batch
3. Only then read the exact code files needed for this batch
4. Do not rescan unrelated directories unless the current batch proves the overview is missing something
5. Keep test execution scoped to touched files first

## Recommended `new_task` Prompt Prefix

Copy the following text into future code subtasks:

```md
Load gstack. Run /autoplan.

Before touching code, first read [`docs/project-structure-overview.md`](hermes-web-ui/docs/project-structure-overview.md) and use it as the initial navigation index.
Only re-read the minimum file set needed for this implementation batch.
Do not re-scan the entire repository unless the overview is insufficient for the current task.
```

## Canonical Launcher Block

When the parent task creates a new code subtask, it should treat the following block as the canonical launcher source of truth and copy it with only the batch goal section changed:

```md
Load gstack. Run /autoplan.

Before touching code, first read [`docs/project-structure-overview.md`](hermes-web-ui/docs/project-structure-overview.md) and use it as the initial navigation index.
Only re-read the minimum file set needed for this implementation batch.
Do not re-scan the entire repository unless the overview is insufficient for the current task.
```

## Recommended Batch Structure

Each code subtask should be a smallest closed loop:

1. one implementation slice
2. one focused validation slice
3. one concise result summary

Examples:

- runtime skeleton only
- input type and metadata contract only
- planner run only
- developer run only
- observability persistence only
- failure path and rollback only

## Recommended Validation Strategy

Validation order for each code subtask:

1. related TypeScript compile check
2. directly related unit tests
3. nearby regression tests if the surface area widened

## Suggested Prompt Example for P4.11-A

```md
Load gstack. Run /autoplan.

Before touching code, first read [`docs/project-structure-overview.md`](hermes-web-ui/docs/project-structure-overview.md) and use it as the initial navigation index.
Only re-read the minimum file set needed for this batch.

Current batch goal:
- implement only P4.11-A2
- extend runtime input and metadata contract
- do not implement planner/developer orchestration yet
- keep GatewayHermesRuntime behavior unchanged
- add only minimal tests for the new contract shape
```

## Maintenance Rule

If a future subtask discovers an important path missing from [`docs/project-structure-overview.md`](hermes-web-ui/docs/project-structure-overview.md), update that document before starting the next subtask.

If the subtask creates a new project-relevant file, it must also update [`docs/project-structure-overview.md`](hermes-web-ui/docs/project-structure-overview.md) before completion.
