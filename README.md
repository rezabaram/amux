# amux -- Agent Multiplexer

Multi-agent coordination for AI coding agents. Agents discover each other, communicate via file-based inboxes, share documents, manage tasks, and build shared knowledge.

Framework-agnostic core with a [Pi](https://github.com/earendil-works/pi) extension included.

## Architecture

```
core/                          Pi-independent, reusable
  registry.ts                  Agent identity (UUID, online/offline)
  messaging.ts                 Crash-safe file-based inboxes
  backlog.ts                   Ordered task queue
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
pi install git:github.com/rezabaram/amux
```

### Standalone (core module)

```bash
git clone https://github.com/rezabaram/amux.git
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
|---------|---------|
| `/amux` | Status and available commands |
| `/amux join` | Join a project as an agent |
| `/amux leave` | Leave project, return to solo mode |
| `/amux manage` | Manage projects, agents, and roles |
| `/amux workspace` | Git workspace operations (sync, status) |

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
| `amux_send` | -- | Send message to an agent |
| `amux_broadcast` | -- | Broadcast to all agents |
| `amux_artifacts` | -- | List shared documents |
| `amux_reserve` | claim, release, list | File/directory reservations |
| `amux_task` | add, list, assign, pick, done, drop, block | Task backlog |
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
  → creates ~/myapp-AgentName on branch agent/AgentName

# Agent starts in their worktree
cd ~/myapp-agent1 && pi
/amux join

# Sync from main
/amux workspace > sync

# Check status
/amux workspace > status
```

## Key Features

- **Framework-agnostic core** -- works with any agent framework, not just Pi
- **Zero overhead** -- invisible until you opt in
- **UUID identity** -- agents persist across restarts
- **Crash-safe messaging** -- messages survive crashes, delivered on reconnect
- **File reservations** -- claim files before editing, prevent conflicts
- **Task backlog** -- assign/pick/done with auto file reservation
- **Shared journal** -- decisions and learnings in every agent's context
- **Git workspaces** -- isolated worktrees per agent
- **Built-in roles** -- ready to use, customizable per project
- **Zero dependencies** -- just Node.js

## Session Files

```
~/.amux/sessions/<project>/
├── agents.json             Agent registry (UUID-keyed)
├── roles.json              Role definitions
├── config.json             Project config (main repo path)
├── backlog.json            Task backlog
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

```bash
npm test    # Verify all files parse correctly
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT -- see [LICENSE](LICENSE).
