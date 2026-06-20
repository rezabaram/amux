# amux -- Agent Multiplexer

Multi-agent coordination for AI coding agents. Agents discover each other, communicate via file-based inboxes, share documents, manage tasks, and build shared knowledge.

Framework-agnostic core with a [Pi](https://github.com/earendil-works/pi) extension included.

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

## Quick Start (Pi)

```bash
# Terminal 1: set up the project
pi
/amux manage          # → Projects > New → create project
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
| `/amux new <type>` | Create project, agent, or role directly |
| `/amux context` | Show/edit project context (CONTEXT.md) |
| `/amux status set` | Set your availability (idle/working/focus/away) |
| `/amux workspace` | Git workspace operations (sync, status) |

### Shortcuts

```bash
/amux new project [name] [--repo current|<path>]
/amux new agent [name] [--role <role>] [--workspace worktree|current|none] [--join]
/amux new role [name]
```

Missing fields are prompted interactively.

### Context

```bash
/amux context           # Show current project context
/amux context edit      # Open editor to edit CONTEXT.md
/amux context set <t>   # Replace project context
/amux context append <t>  # Append to project context
/amux context clear     # Clear project context
/amux context path      # Print CONTEXT.md file path
```

Project context is stored in `artifacts/project/CONTEXT.md` and auto-injected into agent prompts.

### Task Workflow

Task assignments are **state-derived** — agents discover their tasks from the current backlog, not from queued inbox messages. This ensures task context is always current and never stale.

```bash
# View task details + comment history
amux_task({ action: "show", id: "TASK-01" })

# Add a task-scoped comment (like PR comments)
amux_task({ action: "comment", id: "TASK-01", content: "Looks good, one suggestion..." })

# Compact project progress overview
/amux progress
amux_task({ action: "summary" })
```

Lifecycle events (assign, pick, done, drop, block) are automatically recorded as activity in `task-comments/<ITEM-ID>.jsonl`. Use `amux_send` only for exceptional non-task communication.

When shaping larger work, create the high-level item first (`initiative` or `milestone`), add child executable items, review the structure with `/amux progress`, then assign the leaf work. Assign `task`/`bug`/`chore`/`spec` items rather than container items unless you intentionally want broad ownership.

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

## Tools (8)

| Tool | Actions | Purpose |
|------|---------|---------|
| `amux_role` | add, list, remove | Manage role definitions |
| `amux_list` | -- | List online/offline agents |
| `amux_send` | -- | Send message to an agent (exceptional, non-task communication) |
| `amux_broadcast` | -- | Broadcast to all agents |
| `amux_artifacts` | -- | List shared documents |
| `amux_reserve` | claim, release, list | File/directory reservations |
| `amux_task` | add, list, show, comment, assign, pick, done, drop, block, summary | Task backlog with comments, dependencies, batch assign |
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
- **File reservations** -- claim files before editing, prevent conflicts
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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT -- see [LICENSE](LICENSE).
