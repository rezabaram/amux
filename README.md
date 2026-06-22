# amux -- Agent Multiplexer

Multi-agent coordination for AI coding agents. Agents discover each other, communicate via file-based inboxes, share documents, manage tasks, and build shared knowledge.

Framework-agnostic core with a [Pi](https://github.com/earendil-works/pi) extension included.

## Vision

amux turns isolated AI coding agents into an aligned, communicating team that can deliver outcomes no single agent can reliably achieve alone.

The project optimizes for efficient communication, high alignment, and synergistic collaboration: task-scoped discussion instead of scattered messages, state-derived context instead of stale instructions, and structured work coordination so specialized agents can plan, build, review, and harden software together.

See [VISION.md](./VISION.md) for the full vision, principles, and rationale.

## Architecture

```
core/                          Pi-independent, reusable
  storage.ts                   Shared storage layer (paths, JSON/JSONL I/O)
  registry.ts                  Agent identity (UUID, online/offline)
  messaging.ts                 Crash-safe file-based inboxes
  backlog.ts                   Ordered backlog queue (BacklogItem)
  task-comments.ts             Task-scoped comments and activity
  reservations.ts              File/directory reservations
  journal.ts                   Decision & learning log
  index.ts                     Public API + built-in roles

pi/                            Pi extension (uses core)
  index.ts                     Tools, commands, prompt injection

cli/                           Command-line interface (uses core)
  index.ts                     CLI entry point
```

## Install

### Pi Extension

```bash
# Stable (npm)
pi install npm:@amutix/amux

# Latest (git)
pi install git:github.com/amutix/amux
```

### Standalone (core module)

```bash
git clone https://github.com/amutix/amux.git
```

Import the core module directly in your project:

```typescript
import { createAgent, sendMessage, addTask } from "./amux/core/index.ts";
```

### CLI (read-only, phase 1)

```bash
amux progress [--session <name>]     # Project progress overview
amux show <ITEM-ID> [--session <name>]  # Item details + comments
amux list [--session <name>]          # Backlog listing
amux task list [--session <name>]     # Backlog listing (explicit namespace)
amux status [--session <name>]        # Agent availability
amux --help                           # Show available commands
```

Session is auto-detected if only one exists. The CLI uses shared core services and renderers. For full interactive workflows (create, assign, pick, manage), use the Pi extension.

## Quick Start (Pi)

```bash
# Terminal 1: set up the project
pi
/amux manage          # → Projects > New → create project
/amux project vision set "Build ..."  # first alignment artifact for agents
                      # → Roles > New → define roles (or use built-ins)
                      # → Agents > New → create agents with workspaces
/amux join            # → select project → select your agent

# Terminal 2: another agent joins
cd ~/myapp-agent1 && pi
/amux join            # → select project → select agent → start working
```

## Commands

All commands are subcommands of `/amux`:

| Command | Purpose |
|---------|--------|
| `/amux` | Status and available commands |
| `/amux join` | Join a project as an agent |
| `/amux leave` | Leave project, return to solo mode |
| `/amux manage` | Manage projects, agents, and roles (browse UI) |
| `/amux progress` | Project progress overview |
| `/amux show <ITEM-ID>` | Show backlog item details, comments, parent context, and spec preview |
| `/amux new <type>` | Create project, agent, or role directly |
| `/amux project` | Show/set project vision/context |
| `/amux context` | Legacy alias for project context (CONTEXT.md) |
| `/amux wow` | Show/set team Ways of Working (WOW.md) |
| `/amux prompt` | Preview the amux coordination block appended to your system prompt (debug) |
| `/amux status set` | Set your availability (idle/working/focus/away) |
| `/amux workspace` | Git workspace operations (sync, status) |

### Shortcuts

```bash
/amux new project [name] [--repo current|<path>] [--vision <text>]
/amux new agent [name] [--role <role>] [--workspace worktree|current|none] [--join]
/amux new role [name]
```

Missing fields are prompted interactively. New project setup prompts for a project vision/context because it is the first alignment artifact for agents.

### Project Vision / Context

```bash
/amux project                         # Show current project vision/context
/amux project vision set <t>          # Replace project vision/context
/amux project vision append <t>       # Append to project vision/context
/amux project vision edit             # Open editor to edit CONTEXT.md
/amux project vision clear            # Clear project vision/context
/amux project vision path             # Print CONTEXT.md file path
```

Legacy aliases remain available:

```bash
/amux context [show|edit|set|append|clear|path]
```

Project vision/context is stored in `artifacts/project/CONTEXT.md` and auto-injected into agent prompts. Prefer `/amux project vision ...` or the `amux_project` tool over direct file edits.

### Ways of Working

```bash
/amux wow                         # Show current team Ways of Working
/amux wow set <text>              # Replace WOW.md
/amux wow append <text>           # Append to WOW.md
/amux wow edit                    # Open editor to edit WOW.md
/amux wow clear                   # Clear WOW.md
/amux wow path                    # Print WOW.md file path
```

Ways of Working is stored in `artifacts/project/WOW.md` and auto-injected into agent prompts after the built-in common principles. Use it for project-specific collaboration norms: planning depth, review policy, definition of done, communication defaults, escalation, and retro habits. Keep it concise because it appears in every agent's prompt. Agents can also use the `amux_wow` tool.

### Prompt preview

```bash
/amux prompt                      # Section summary for this agent
/amux prompt roleProfile          # Preview one section
/amux prompt all                  # Explicitly show the full amux-appended block
```

amux **appends** a coordination block to Pi's base system prompt — it never replaces the base prompt. `/amux prompt` is a debug surface for understanding what each agent actually sees. By default it shows a compact section summary to avoid dumping the whole prompt; inspect a single section by name (for example `teamContext`) or use `/amux prompt all` when you explicitly want the full amux-appended block. Pi's base system prompt is **not** shown (amux never sees or owns it). The preview uses the same gathering path that injects the live prompt, so it never drifts from what agents receive.

### Task Workflow

Task assignments are **state-derived** — agents discover their tasks from the current backlog, not from queued inbox messages. This ensures task context is always current and never stale.

```bash
# View task details + comment history
/amux show TASK-01
amux_task({ action: "show", id: "TASK-01" })

# Add a task-scoped comment (like PR comments)
amux_task({ action: "comment", id: "TASK-01", content: "Looks good, one suggestion..." })

# Compact project progress overview
/amux progress
amux_task({ action: "summary" })
```

Lifecycle events (assign, pick, review, done, drop, block) are automatically recorded as activity in `task-comments/<ITEM-ID>.jsonl`. Use `review` when implementation is ready for review/integration; use `done` when work is reviewed, integrated, and verified. Simple workflows can still mark work done directly. Use `amux_send` only for exceptional non-task communication; delivered messages show intent and age so stale context is visible.

For token-efficient review handoff, include a compact free-form summary when marking work ready for review:

```bash
amux_task({
  action: "review",
  id: "TASK-01",
  summary: "Commit abc123 on agent/alice. Diff: extracted auth parser. Tests: npm test. Risk: token refresh edge cases."
})
```

Reviewer flow: read the linked spec, inspect the diff, inspect test output, then add a task comment or mark the item done. This keeps review scoped to spec + diff + tests instead of reloading broad project context.

When shaping larger work, create the high-level item first (`initiative` or `milestone`), add child executable items, review the structure with `/amux progress`, then assign the leaf work. Assign `task`/`bug`/`chore`/`spec` items rather than container items unless you intentionally want broad ownership.

**Documentation types:**

| Type | Use for | Tool |
|------|---------|------|
| Task description | Brief inline context and acceptance criteria | `amux_task add` |
| Linked spec | Detailed plans, checklists, design notes | `amux_task plan/edit-plan` |
| Journal | Decisions, learnings, progress shared across agents | `amux_journal add` |

**Recommended workflow:** Create a high-level initiative with child tasks, assign all executable leaves to the intended agent(s) upfront, and let `dependsOn` enforce ordering. The assignee picks one task at a time after completing the current one. Auto-pick (`amux_task pick` without an ID) prefers assigned-to-self items with met dependencies before open todo items.

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
/amux status set idle        # Ready for new work
/amux status set working     # Actively working (auto-set on pick)
/amux status set focus       # Do not interrupt
/amux status set away        # Unavailable
```

Availability is auto-updated by task lifecycle: `pick` → working, `done`/`drop` → idle (preserves explicit focus/away). Idle agents receive a single generic attention signal when new work is assigned; working/focus/away agents are not interrupted.

### Manage

```
/amux manage
  → Projects     new, rename, delete, set main repo
  → Agents       new (with role + optional workspace), rename, delete
  → Roles        new, delete
```

## Tools (10)

| Tool | Actions | Purpose |
|------|---------|---------|
| `amux_role` | add, list, remove, templates, apply-template, show, path | Manage roles and apply team templates |
| `amux_list` | -- | List online/offline agents |
| `amux_send` | -- | Send message to an agent (exceptional, non-task communication) |
| `amux_broadcast` | -- | Broadcast to all agents |
| `amux_artifacts` | -- | List shared documents |
| `amux_project` | show, set, append, clear, path | Manage project vision/context |
| `amux_wow` | show, set, append, clear, path | Manage project/team Ways of Working |
| `amux_reserve` | claim, release, list | File/directory reservations |
| `amux_task` | add, list, show, comment, assign, pick, review, done, drop, block, summary | Task backlog with comments, dependencies, batch assign |
| `amux_journal` | add, list | Record decisions and learnings |

## Built-in Roles

Five role templates ship with amux, ready to use during agent creation:

| Role | Description |
|------|-------------|
| `developer` | Write clean, well-structured code |
| `architect` | System design, trade-offs, technical decisions |
| `reviewer` | Code review, quality, constructive feedback |
| `devops` | Infrastructure, CI/CD, deployment |
| `planner` | Task breakdown, requirements, coordination |

Built-in roles are copied to the project on first use and can be customized.

## Role Profiles & Team Templates

For lead-agent orchestration, amux ships richer **role profiles** (markdown) and **team templates** for quick setup.

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
amux_role({ action: "templates" })                       # list bundled profiles + teams
amux_role({ action: "apply-template", template: "core-team" })  # copy profiles + register roles
amux_role({ action: "show", name: "lead-architect" })    # resolved role text
amux_role({ action: "path", name: "lead-architect" })    # project-local profile file path
```

Applying a team template copies the role markdown into `artifacts/project/roles/` and registers role definitions. It **does not create agents** — create those separately via `/amux manage` or `/amux new agent`. The copied markdown is the source of truth (`profilePath`); edit it to customize a role. Existing customized profiles are preserved unless `force` is used. Legacy roles with inline `instructions` continue to work unchanged.

## Lead Orchestration Workflow

amux is built for a lead agent (e.g. the `lead-architect` role) to turn high-level user goals into coordinated, reviewed delivery through a team of specialists. The recommended lead loop:

1. **Clarify the goal** — outcomes, constraints, non-goals.
2. **Confirm/update project vision** — `amux_project` (durable, prompt-injected context).
3. **Create structure** — an initiative/milestone/spec for the work.
4. **Decompose** — break into executable leaf tasks with `files` and `dependsOn`.
5. **Delegate** — assign executable leaves to specialists (not container items); assign ready leaves up front and let `dependsOn` enforce order.
6. **Monitor** — `amux_task summary` / `/amux progress`, reservations, review status.
7. **Require review** — substantive work goes to `review` before `done`.
8. **Integrate** — verify and merge the final changes.
9. **Report** — give the user a clear outcome: what shipped, files/commits, tests, decisions, risks, next steps.

This workflow is guidance, not magic automation — the lead agent orchestrates through the existing primitives (`amux_task`, `amux_project`, reservations, journal). There is no auto-decomposition action; decomposition is the lead's judgment and stays reviewable.

### Prompt composition

amux **appends** a composed coordination block to Pi's base system prompt (it never replaces it). The block is assembled in a deliberate, documented order (see `core/prompt-assembly.ts`):

1. Common amux operating principles (collaboration contract)
2. Project vision/context
3. Role profile (role-specific only)
4. Agent identity + workspace
5. Current work state (active/assigned/review items, spec preview, recent comments)
6. Team/project snapshot/reservation context
7. Interface/tool guidance and shared artifact paths

Role profiles supply only the role-specific section; common principles, vision, work state, and interface guidance are separate, deliberately-ordered sections.

## Team Learning & Retrospectives

amux teams learn from mistakes, successes, and user corrections through **curated learnings** — selective, durable lessons that evolve how the team works.

### Artifact boundaries

| Artifact | Purpose | Changes how |
|----------|---------|-------------|
| `CONTEXT.md` | Project vision and strategy | Via `/amux context` or `amux_project` |
| `WOW.md` | Team collaboration norms | Via `/amux wow` or `amux_wow` |
| role profiles | Per-role behavior | Via editing `roles/<name>.md` |
| `journal.jsonl` | Curated lessons, decisions, proposals | Via `amux_journal add` |

### Retrospectives

After completing a major initiative or milestone, the lead runs a **lightweight retro** (no new command — just 4 questions through existing primitives):

1. What worked?
2. What failed or caused rework?
3. What user correction should we remember?
4. What should change in WoW, role profiles, or project context?

Outputs are recorded as `amux_journal` learning entries. Norm-changing proposals use the `context: "wow-proposal"` convention — the journal entry is the proposal; WoW only changes by deliberate lead/user edit via `/amux wow`. Nothing auto-mutates.

## Workspaces

Agents can work in isolated git worktrees:

```bash
# Architect sets up (from /amux manage)
Agents > New → name, role, workspace: "New worktree"
  → creates ~/myapp-alice on branch agent/alice
  (names are sanitized: "My Agent!" → agent/my-agent)

# Agent starts in their worktree
cd ~/myapp-alice && pi
/amux join

# Sync from main (fetches origin, rebases on origin/<mainBranch>)
/amux workspace > sync

# Check status (compares against origin/<mainBranch>)
/amux workspace > status
```

Sync runs `git fetch origin` followed by `git rebase origin/<mainBranch>`, where `<mainBranch>` is the current branch of the main repo (defaults to `main`). This avoids rebasing against a stale local branch. Status compares commit counts against the same remote ref and handles missing refs gracefully.

## Key Features

- **Framework-agnostic core** -- works with any agent framework, not just Pi
- **Zero overhead** -- invisible until you opt in
- **UUID identity** -- 128-bit UUIDs, unique names per session (case-insensitive), agents persist across restarts
- **Heartbeat presence** -- crashed agents auto-expire after 90s, stale reservations cleared automatically
- **Agent availability** -- idle/working/focus/away status, auto-updated by task lifecycle, generic attention signals for idle agents
- **Crash-safe messaging** -- messages survive crashes, delivered on reconnect
- **File reservations** -- claim files before editing; conflicts show age, linked task context, and owner work state
- **Task backlog** -- state-derived workflow with task-scoped comments, dependencies, batch assign, assignee ownership. Assignments are visible via task state, not inbox messages.
- **Shared journal** -- decisions and learnings in every agent's context
- **Git workspaces** -- isolated worktrees per agent
- **Built-in roles** -- ready to use, customizable per project
- **Zero dependencies** -- just Node.js

## Session Files

Default root: `~/.amux/sessions/`. Override with environment variables:

| Variable | Effect |
|----------|--------|
| `AMUX_SESSIONS_DIR` | Use this path as the sessions directory (highest priority) |
| `AMUX_HOME` | Use `$AMUX_HOME/sessions` as the sessions directory |

Both core modules and the Pi adapter resolve the same root.

```
~/.amux/sessions/<project>/
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

See [`benchmarks/solo-vs-amux/`](benchmarks/solo-vs-amux/) for the solo-vs-amux token efficiency benchmark harness.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT -- see [LICENSE](LICENSE).
