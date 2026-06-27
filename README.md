# amutix -- Coordination layer for AI agent teams

amutix is a local, file-backed coordination layer for AI coding agents.

It provides shared project state for agents working in the same repository: who the agents are, what work exists, who owns it, what is blocked, which files are reserved, and what context should be injected into each agent's prompt.

The core is framework-agnostic. This package includes a [Pi](https://github.com/earendil-works/pi) extension and a read-only CLI.

## Scope

Use amutix when you already have multiple coding agents or sessions and need a lightweight way to coordinate them.

It is not an LLM runtime, hosted agent platform, workflow DAG engine, or automatic planner.

## Core surfaces

- **Project context**: shared goal, constraints, and direction
- **Ways of Working**: project-specific team norms
- **Roles and team templates**: reusable agent responsibilities
- **Backlog**: initiatives, milestones, tasks, bugs, chores, specs, dependencies
- **Task comments**: discussion attached to the work
- **Reservations**: advisory file/path ownership
- **Journal**: decisions, learnings, and progress
- **Prompt assembly**: compact state-derived context for each agent

## Architecture

```
core/                          Host-runtime independent coordination library
  storage.ts                   Shared storage layer (paths, JSON/JSONL I/O)
  registry.ts                  Agent identity (UUID, online/offline)
  messaging.ts                 Crash-safe file-backed inboxes
  backlog.ts                   Structured backlog items and specs
  task-comments.ts             Task-scoped comments and activity
  reservations.ts              File/directory reservations
  journal.ts                   Decision & learning log
  roles.ts                     Project-local roles and team templates
  prompt-assembly.ts           Deliberate coordination prompt composition
  renderers.ts                 Shared progress/task/team renderers

pi/                            Pi adapter: tools, commands, prompt injection
cli/                           Read-only CLI over shared core services
```

See [VISION.md](./VISION.md) for the full vision, principles, and rationale.

## Install

### Pi Extension

```bash
# Stable (npm)
pi install npm:amutix

# Latest (git)
pi install git:github.com/amutix/amutix
```

### Standalone (core module)

```bash
git clone https://github.com/amutix/amutix.git
```

Import the core module directly in your project:

```typescript
import { createAgent, sendMessage, addTask } from "./amutix/core/index.ts";
```

### CLI (read-only, phase 1)

```bash
amutix work [--session <name>]         # Project progress overview
amutix work show <ITEM-ID> [--session <name>]  # Item details + comments
amutix team [--session <name>]         # Agent availability
amutix project [--session <name>]      # Vision/WoW/role overview
amutix list [--session <name>]         # Backlog listing
amutix progress/show/status            # Compatibility aliases
amutix --help                           # Show available commands
```

Session is auto-detected if only one exists. The CLI uses shared core services and renderers. For full interactive workflows (create, assign, pick), use the Pi extension.

## Quick Start (Pi)

```bash
# Terminal 1: set up the project
pi
/amutix new project myapp --repo current --vision "Build ..."
/amutix new agent Lead --role architect --workspace current --join
/amutix new agent Developer --role developer --workspace worktree

# Terminal 2: another agent joins
cd ~/myapp-agent1 && pi
/amutix join            # → select project → select agent → start working
```

[cprune: omitted prior tool-call argument edit.arguments.edits[0].newText; 1952 chars; hash=efc60b561f2fc8b4; preview="## Commands amutix has five command surfaces: | Surface | Purpose | Examples | |---------|---------|----------| | Project | Alignment artifacts: vision, WoW, roles/templates | `/amutix project`, `/amutix project vision set ...`, `/amutix project wow ...` | | Team | Agents, roles, availability"]

### Project Vision / Context

```bash
/amutix project                         # Show current project vision/context
/amutix project vision set <t>          # Replace project vision/context
/amutix project vision append <t>       # Append to project vision/context
/amutix project vision edit             # Open editor to edit CONTEXT.md
/amutix project vision clear            # Clear project vision/context
/amutix project vision path             # Print CONTEXT.md file path
/amutix project wow ...                 # Manage Ways of Working (also available as /amutix wow)
```

Project vision/context is stored in `artifacts/project/CONTEXT.md` and auto-injected into agent prompts. Prefer `/amutix project vision ...` or the `amutix_project` tool over direct file edits.

### Ways of Working

```bash
/amutix wow                         # Show current team Ways of Working
/amutix wow set <text>              # Replace WOW.md
/amutix wow append <text>           # Append to WOW.md
/amutix wow edit                    # Open editor to edit WOW.md
/amutix wow clear                   # Clear WOW.md
/amutix wow path                    # Print WOW.md file path
```

Ways of Working is stored in `artifacts/project/WOW.md` and auto-injected into agent prompts after the built-in common principles. New projects start with a small default WoW covering task comments, review, waiting/reminders, and learnings. Edit it for project-specific collaboration norms. Keep it concise because it appears in every agent's prompt. Agents can also use the `amutix_wow` tool.

### Prompt preview

```bash
/amutix prompt                      # Section summary for this agent
/amutix prompt roleProfile          # Preview one section
/amutix prompt all                  # Explicitly show the full amutix-appended block
```

amutix **appends** a coordination block to the host agent runtime's base system prompt — it never replaces the base prompt. `/amutix prompt` is a debug surface for understanding what each agent actually sees. By default it shows a compact section summary to avoid dumping the whole prompt; inspect a single section by name (for example `teamContext`) or use `/amutix prompt all` when you explicitly want the full amutix-appended block. The host's base system prompt is **not** shown (amutix never sees or owns it). The preview uses the same gathering path that injects the live prompt, so it never drifts from what agents receive.

### Task Workflow

Task assignments are **state-derived** — agents discover their tasks from the current backlog, not from queued inbox messages. This ensures task context is always current and never stale.

```bash
# View compact task details
/amutix work show TASK-01
/amutix show TASK-01        # shortcut
amutix_task({ action: "show", id: "TASK-01" })

# Add a task-scoped comment (like PR comments)
amutix_task({ action: "comment", id: "TASK-01", content: "Looks good, one suggestion..." })

# Compact project progress overview
/amutix work
/amutix progress            # shortcut
amutix_task({ action: "summary" })
amutix_task({ action: "archive" })   # Move done items out of the active backlog
```

Lifecycle events (assign, pick, review, done, drop, block) are automatically recorded as activity in `task-comments/<ITEM-ID>.jsonl`. Task comments are durable and notify relevant subscribers by default (assignee, creator, previous commenters, and `@AgentName` mentions); pass `notify: false` or `silent: true` for a quiet note. When a lifecycle change needs another agent's attention (ready for review, blocked, unblocked, dependency handoff, help needed), add a task comment mentioning that agent; do not reassign work just to notify. Agent prompts include only compact latest substantive task-discussion previews; full comment history stays pull-based via `amutix_task show`. Use `review` when implementation is ready for review/integration; use `done` when work is reviewed, integrated, and verified. Use `archive` to move done items that are no longer needed for ongoing implementation out of the active backlog. Simple workflows can still mark work done directly. Use `amutix_send` only for exceptional non-task communication; delivered messages show intent and age so stale context is visible.

For direct messages that need an answer, set `responseRequired: true`; `brainstorm` messages default to requiring a response. Pending replies are shown in the sender's prompt until the recipient replies with `inReplyTo`.

### Team discussions

Use `amutix_discussion` for cross-cutting multi-party collaboration such as retros, brainstorms, design jams, and syncs. Keep task-scoped discussion on `amutix_task comment`; discussions are for topics whose audience is a group rather than one task thread.

```bash
amutix_discussion({ action: "start", topic: "Retro: v1.2", kind: "retro", audience: "all" })
amutix_discussion({ action: "start", topic: "Storage design", audience: "agents", participants: ["Lead", "Developer2"] })
amutix_discussion({ action: "post", id: "DISC-01", content: "One option is..." })
amutix_discussion({ action: "close", id: "DISC-01", summary: "Outcome: use append-only JSONL." })
```

Audience controls expected participation and notifications, not access control. `all` resolves all same-session agents at creation time; `agents` resolves the explicit same-session participants. Open discussions appear in prompts as compact metadata only; full discussion text is shown on demand with `show`.

For token-efficient review handoff, include a compact free-form summary when marking work ready for review:

```bash
amutix_task({
  action: "review",
  id: "TASK-01",
  summary: "Commit abc123 on agent/alice. Diff: extracted auth parser. Tests: npm test. Risk: token refresh edge cases."
})
```

Reviewer flow: read the linked spec, inspect the diff, inspect test output, then add a task comment or mark the item done. This keeps review scoped to spec + diff + tests instead of reloading broad project context.

When shaping larger work, create the high-level item first (`initiative` or `milestone`), add child executable items, review the structure with `/amutix progress`, then assign the leaf work. Assign `task`/`bug`/`chore`/`spec` items rather than container items unless you intentionally want broad ownership.

**Documentation types:**

| Type | Use for | Tool |
|------|---------|------|
| Task description | Brief inline context and acceptance criteria | `amutix_task add` |
| Linked spec | Detailed plans, checklists, design notes | `amutix_task plan/edit-plan` |
| Journal | Decisions, learnings, progress shared across agents | `amutix_journal add` |

**Recommended workflow:** Create a high-level initiative with child tasks, assign all executable leaves to the intended agent(s) upfront, and let `dependsOn` enforce ordering. The assignee picks one task at a time after completing the current one. Auto-pick (`amutix_task pick` without an ID) prefers assigned-to-self items with met dependencies before open todo items.

### Backlog Model

Backlog items (`BacklogItem`) support optional structure fields:

| Field | Purpose |
|-------|---------|
| `itemType` | `task` (default), `initiative`, `milestone`, `bug`, `chore`, `spec` |
| `dependsOn` | Array of task IDs that must be done before this item can be picked |
| `parentId` | Parent item ID for hierarchy grouping |
| `order` | Sort order within siblings |

Existing items without these fields behave as regular tasks. New item IDs use type-specific prefixes: `TASK-*`, `INIT-*`, `MS-*`, `BUG-*`, `CHORE-*`, and `SPEC-*`. Existing `TASK-*` IDs remain valid.

### Availability

```bash
/amutix status set idle        # Ready for new work
/amutix status set working     # Actively working (auto-set on pick)
/amutix status set focus       # Do not interrupt
/amutix status set away        # Unavailable
```

Availability is auto-updated by task lifecycle: `pick` → working, `done`/`drop` → idle (preserves explicit focus/away). Idle agents receive a concrete assignment notification when new work is assigned; working/focus/away agents are not interrupted.

## Tools (11)

| Tool | Actions | Purpose |
|------|---------|---------|
| `amutix_role` | add, list, remove, templates, apply-template, show, path | Manage roles and apply team templates |
| `amutix_list` | -- | List online/offline agents |
| `amutix_send` | -- | Send message to an agent (exceptional, non-task communication; supports response-required tracking) |
| `amutix_discussion` | start, post, show, list, close | Multi-party discussions for retros, brainstorms, design jams |
| `amutix_broadcast` | -- | Broadcast to all agents |
| `amutix_artifacts` | -- | List shared documents |
| `amutix_project` | show, set, append, clear, path | Manage project vision/context |
| `amutix_wow` | show, set, append, clear, path | Manage project/team Ways of Working |
| `amutix_reserve` | claim, release, list | File/directory reservations |
| `amutix_task` | add, list, show, comment, assign, pick, review, done, drop, block, archive, summary | Task backlog with comments, dependencies, batch assign, archive done items |
| `amutix_journal` | add, list | Record decisions and learnings |

## Built-in Roles

Five role templates ship with amutix, ready to use during agent creation:

| Role | Description |
|------|-------------|
| `developer` | Write clean, well-structured code |
| `architect` | System design, trade-offs, technical decisions |
| `reviewer` | Code review, quality, constructive feedback |
| `devops` | Infrastructure, CI/CD, deployment |
| `planner` | Task breakdown, requirements, coordination |

Built-in roles are copied to the project on first use and can be customized.

## Role Profiles & Team Templates

For lead-agent orchestration, amutix ships richer **role profiles** (markdown) and **team templates** for quick setup.

**Bundled role profiles** (`roles/*.md`):

| Profile | Focus |
|---------|-------|
| `lead-architect` | Decompose goals, delegate, coordinate, guard quality |
| `developer` | Implement assigned tasks from specs, write tests |
| `reviewer` | Verify implementations against specs and acceptance criteria |

**Team templates** (`team-templates/*.json`):

| Template | Roles |
|----------|-------|
| `core-team` | lead-architect + developer + reviewer |

```bash
amutix_role({ action: "templates" })                       # list bundled profiles + teams
amutix_role({ action: "apply-template", template: "core-team" })  # copy profiles + register roles
amutix_role({ action: "show", name: "lead-architect" })    # resolved role text
amutix_role({ action: "path", name: "lead-architect" })    # project-local profile file path
```

Applying a team template copies the role markdown into `artifacts/project/roles/` and registers role definitions. It **does not create agents** — create those separately via `/amutix new agent`. The copied markdown is the source of truth (`profilePath`); edit it to customize a role. Existing customized profiles are preserved unless `force` is used.

## Lead Orchestration Workflow

amutix is built for a lead agent (e.g. the `lead-architect` role) to turn high-level user goals into coordinated, reviewed delivery through a team of specialists. The recommended lead loop:

1. **Clarify the goal** — outcomes, constraints, non-goals.
2. **Confirm/update project vision** — `amutix_project` (durable, prompt-injected context).
3. **Create structure** — an initiative/milestone/spec for the work.
4. **Decompose** — break into executable leaf tasks with `files` and `dependsOn`.
5. **Delegate** — assign executable leaves to specialists (not container items); assign ready leaves up front and let `dependsOn` enforce order.
6. **Monitor** — `amutix_task summary` / `/amutix progress`, reservations, review status.
7. **Require review** — substantive work goes to `review` before `done`.
8. **Integrate** — verify and merge the final changes.
9. **Archive** — move done items no longer needed for ongoing implementation out of the active backlog.
10. **Report** — give the user a clear outcome: what shipped, files/commits, tests, decisions, risks, next steps.

This workflow is guidance, not magic automation — the lead agent orchestrates through the existing primitives (`amutix_task`, `amutix_project`, reservations, journal). There is no auto-decomposition action; decomposition is the lead's judgment and stays reviewable.

### Prompt composition

amutix **appends** a composed coordination block to the host agent runtime's base system prompt (it never replaces it). The block is assembled in a deliberate, documented order (see `core/prompt-assembly.ts`):

1. Common amutix operating principles (collaboration contract)
2. Project vision/context
3. Role profile (role-specific only)
4. Agent identity + workspace
5. Current work state (active/assigned/review items, spec preview, recent comments)
6. Team/project snapshot/reservation context
7. Interface/tool guidance and shared artifact paths

Role profiles supply only the role-specific section; common principles, vision, work state, and interface guidance are separate, deliberately-ordered sections.

## Team Learning & Retrospectives

amutix teams learn from mistakes, successes, and user corrections through **curated learnings** — selective, durable lessons that evolve how the team works.

### Artifact boundaries

| Artifact | Purpose | Changes how |
|----------|---------|-------------|
| `CONTEXT.md` | Project vision and strategy | Via `/amutix project vision` or `amutix_project` |
| `WOW.md` | Team collaboration norms | Via `/amutix wow` or `amutix_wow` |
| role profiles | Per-role behavior | Via editing `roles/<name>.md` |
| `journal.jsonl` | Curated lessons, decisions, proposals | Via `amutix_journal add` |

### Retrospectives

After completing a major initiative or milestone, the lead runs a **lightweight retro** (no new command — just 4 questions through existing primitives):

1. What worked?
2. What failed or caused rework?
3. What user correction should we remember?
4. What should change in WoW, role profiles, or project context?

Outputs are recorded as `amutix_journal` learning entries. Norm-changing proposals use the `context: "wow-proposal"` convention — the journal entry is the proposal; WoW only changes by deliberate lead/user edit via `/amutix wow`. Nothing auto-mutates.

## Workspaces

Agents can work in isolated git worktrees:

```bash
# Create an agent with a dedicated worktree
/amutix new agent Alice --role developer --workspace worktree
# → creates ~/myapp-alice on branch agent/alice
# names are sanitized: "My Agent!" → agent/my-agent

# Agent starts in their worktree
cd ~/myapp-alice && pi
/amutix join

# Sync from main (fetches origin, rebases on origin/<mainBranch>)
/amutix workspace > sync

# Check status (compares against origin/<mainBranch>)
/amutix workspace > status
```

Sync runs `git fetch origin` followed by `git rebase origin/<mainBranch>`, where `<mainBranch>` is the current branch of the main repo (defaults to `main`). This avoids rebasing against a stale local branch. Status compares commit counts against the same remote ref and handles missing refs gracefully.

## Key Features

- **Framework-agnostic core** -- works with any agent framework, not just Pi
- **Zero overhead** -- invisible until you opt in
- **UUID identity** -- 128-bit UUIDs, unique names per session (case-insensitive), agents persist across restarts
- **Heartbeat presence** -- crashed agents auto-expire after 90s, stale reservations cleared automatically
- **Agent availability** -- idle/working/focus/away status, auto-updated by task lifecycle, descriptive attention notifications for idle agents
- **Crash-safe messaging** -- messages survive crashes, delivered on reconnect
- **File reservations** -- claim files before editing; conflicts show age, linked task context, and owner work state
- **Task backlog** -- state-derived workflow with task-scoped comments, dependencies, batch assign, assignee ownership. Assignments are visible via task state, not inbox messages.
- **Shared journal** -- decisions and learnings in every agent's context
- **Git workspaces** -- isolated worktrees per agent
- **Built-in roles** -- ready to use, customizable per project
- **Zero dependencies** -- just Node.js

## Session Files

Default root: `~/.amutix/sessions/`. Override with environment variables:

| Variable | Effect |
|----------|--------|
| `AMUTIX_SESSIONS_DIR` | Use this path as the sessions directory (highest priority) |
| `AMUTIX_HOME` | Use `$AMUTIX_HOME/sessions` as the sessions directory |

Both core modules and the Pi adapter resolve the same root.

```
~/.amutix/sessions/<project>/
├── agents.json             Agent registry (UUID-keyed)
├── roles.json              Role definitions
├── config.json             Project config (main repo path)
├── backlog.json            Task backlog
├── task-comments/          Per-task comment/activity history (JSONL)
├── reservations.json       File reservations
├── journal.jsonl           Decisions & learnings
├── messages.log            Message history
├── inbox/<agent-uuid>/     Per-agent message inbox
└── artifacts/
    ├── project/            Shared across all agents
    │   └── CONTEXT.md      Auto-injected into agent prompts
    └── agents/<uuid>/      Private per-agent space
```

## Development

Requires Node >= 22 (uses `--experimental-strip-types`).

```bash
npm test    # Parse-check all .ts files + run E2E flow tests
```

### Benchmarks

See [`benchmarks/solo-vs-amutix/`](benchmarks/solo-vs-amutix/) for the solo-vs-amutix token efficiency benchmark harness.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT -- see [LICENSE](LICENSE).
