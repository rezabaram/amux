# amutix Vision

## One-line vision

amutix turns isolated AI coding agents into an aligned, communicating engineering team that can deliver outcomes no single agent can reliably achieve alone.

## Mission

amutix exists to make multi-agent software work practical: efficient communication, high alignment, and coordinated execution across specialized agents.

A single agent can be fast, but it is bounded by one context window, one line of thought, and one working memory. A coordinated agent team can divide work, review each other, preserve decisions, maintain project state, and compound progress — but only if communication and alignment are cheap enough to avoid chaos.

amutix is the coordination layer for that team.

## Core belief

The hard problem in multi-agent coding is not sending messages. It is keeping work aligned while multiple agents act independently.

Without coordination, agents create stale instructions, duplicate work, hidden decisions, file conflicts, and divergent plans. With the right coordination layer, agents can behave more like a well-run development team: shared goals, clear ownership, visible progress, durable decisions, and respectful handoffs.

## What amutix optimizes for

### 1. Efficient communication

Agents should exchange the right information at the right time, without stale instructions, inbox noise, or repeated context dumps.

amutix favors:

- task-scoped comments over scattered direct messages
- state-derived prompts over queued task instructions
- concise attention signals over long interrupting notifications
- shared project context and journals over repeated explanation
- compact progress views over ambiguous status chatter

### 2. High alignment

Agents should know the project goal, current plan, ownership boundaries, dependencies, and latest decisions before they act.

amutix favors:

- hierarchical backlog items for shared structure
- parent context for child work
- visible progress summaries
- durable decisions and learnings
- explicit dependencies and file reservations
- typed work items that reveal intent through IDs (`INIT-*`, `TASK-*`, `BUG-*`, `SPEC-*`)

### 3. Synergistic collaboration

The point is not to run many agents independently. The point is to make their combined work better than the sum of separate runs.

amutix should help agents:

- split complex work into coherent slices
- work in parallel without stepping on each other
- use specialized roles for architecture, implementation, review, operations, and planning
- review and harden each other's output
- preserve useful context across sessions
- deliver results that would be difficult for a single agent working alone

## Product principles

1. **State is the source of truth, not messages.**  
   Agents should derive current truth from backlog, registry, comments, reservations, and journal state. Messages are for exceptional communication, not stale task instructions.

2. **Agents coordinate like a dev team, not a message bus.**  
   Roles define specialization. File reservations prevent edit conflicts. Task comments keep discussion with the work. Journals capture decisions. Workspaces isolate implementation.

3. **Backlog is the active coordination surface.**  
   Work, context, comments, dependencies, and progress should be visible through the backlog instead of hidden in ad-hoc messages or documents.

4. **Assign work, not confusion.**  
   Create the high-level structure first, then assign executable leaf items with enough parent context to start safely.

5. **Structure emerges; it is not imposed.**  
   A flat list works for simple projects. Add `itemType` when type matters, `parentId` when hierarchy matters, `dependsOn` when ordering matters, and `specPath` when planning needs more room.

6. **Make coordination cheap.**  
   The overhead of collaboration must stay lower than the value of parallelism. Commands should be short, summaries compact, defaults obvious, and workflows composable.

7. **Preserve attention.**  
   Interruptions should be generic, coalesced, and respectful of focus/away states. Agents should pull detail when ready.

8. **Stay local, file-based, and crash-safe.**  
   amutix should not require a server or database to coordinate agents. JSON state, append-only logs, atomic writes, file locks, heartbeat TTLs, and recoverable inboxes make collaboration robust and inspectable.

9. **Keep adapters thin.**  
   Core workflows and renderers should be framework-agnostic. Pi, CLI, and future interfaces should share the same behavior.

10. **Prefer simple primitives that compose.**  
    Roles, backlog items, comments, reservations, journal entries, and artifacts should remain understandable alone while combining into stronger workflows.

## Why state-derived coordination matters

When one agent assigns `TASK-05` to another, amutix should not rely on a queued message body as the source of truth. The backlog records `TASK-05` as assigned. When the assignee's next turn starts, prompt context is generated from current state.

If the task was reassigned, completed, blocked, or expanded before the assignee wakes up, they see the current truth — not an old instruction that merely arrived late.

This is the difference between coordination and messaging.

## Why the development-team metaphor matters

The strongest multi-agent workflows resemble a disciplined engineering team:

- an architect defines boundaries and trade-offs
- a developer implements a focused slice
- a reviewer catches quality issues
- a planner keeps dependencies and progress clear
- a devops agent validates packaging or deployment

amutix provides the shared surfaces these roles need: backlog, comments, reservations, journals, artifacts, workspaces, and progress views.

## Rationale

Multi-agent systems fail when communication becomes more expensive than execution. They produce stale instructions, duplicate work, file conflicts, hidden decisions, and unreviewed divergence.

amutix addresses those failure modes by making coordination explicit and lightweight:

- **Shared state** replaces fragile memory.
- **Task-scoped history** replaces scattered chat.
- **Hierarchy and dependencies** replace flat, ambiguous task lists.
- **Reservations** reduce edit conflicts.
- **Journals** preserve decisions and learnings.
- **Attention signals** wake agents without flooding them with stale details.
- **Shared services/renderers** keep interfaces consistent across Pi and CLI.

The desired outcome is a team of agents that can plan, build, review, and harden software together — maintaining alignment while exploiting parallelism.

## North star

A user should be able to give amutix a complex software goal, step away, and return to a clearly coordinated project state: what was planned, who did what, what changed, what remains, and why the result is better than a single-agent attempt.
