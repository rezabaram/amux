# Changelog

## 2.0.0 (2026-06-27)

### Changed — Product rebrand: amux → amutix

The generic "amux" (agent-multiplexer) name collided head-on with another open-source project (`mixpeek/amux`, which owns `amux.io` and comparison pages). As of 2.0.0, the product is rebranded to **amutix** — our existing GitHub/npm org name, now also the product name, binary name, and npm package name.

- **Product name**: amux → amutix
- **Binary**: `amux` → `amutix`
- **npm package**: `@amutix/amux` → `amutix` (unscoped) and `amux-pi` → `@amutix/pi`
- **Slash command**: `/amux` → `/amutix` (with `/amux` back-compat alias, removed in 3.0)
- **Tool names**: all `amux_*` tools → `amutix_*` (with `amux_*` aliases, removed in 3.0):
  - `amutix_task`, `amutix_send`, `amutix_broadcast`, `amutix_discussion`, `amutix_role`, `amutix_reserve`, `amutix_journal`, `amutix_project`, `amutix_wow`, `amutix_artifacts`, `amutix_list`
- **Message format**: `[amux:...]` → `[amutix:...]`
- **Data directory**: `~/.amux/` → `~/.amutix/` (with read-fallback to `~/.amux/` for pre-2.0 sessions; no automatic migration needed)
- **Environment variables**: `AMUX_SESSIONS_DIR` → `AMUTIX_SESSIONS_DIR`, `AMUX_HOME` → `AMUTIX_HOME` (legacy aliases preserved, removed in 3.0)

### Migration guide

Existing sessions work without migration: amutix 2.0 reads `~/.amux/` data automatically if `~/.amutix/` doesn't exist. For a clean move, rename the directory:

```bash
mv ~/.amux ~/.amutix
```

Agents and scripts using old `amux_*` tool names and `/amux` commands continue to work via back-compat aliases (deprecated, scheduled for removal in 3.0).

## Unreleased

No changes yet.

## 1.3.0 (2026-06-24)

### Added

- `amux_discussion` for multi-party team discussions: start, post, show, list, and close with participant-aware notifications and compact open-discussions prompt metadata.
- `amux_send` response-required messages and pending-reply tracking; brainstorm messages now default to requiring a response.
- `amux_task archive` to move completed backlog items out of the active backlog while preserving archive history.
- Task comments notify relevant task subscribers by default, so assignees/participants wake and reassess task state without separate direct messages.
- Lifecycle notification targets for `amux_task` transitions: `notifyTarget` (`none`, `subscribers`, `all`, `agents`) and `notifyAgents` support review/blocker/handoff wake-ups without changing ownership.
- A pure task transition state-machine seam with centralized transition metadata and side-effect descriptors.
- Grouped command aliases for the simpler Project/Team/Work mental model: `/amux work`, `/amux work show`, `/amux team`, `/amux project wow`, plus CLI `amux work`, `amux work show`, `amux team`, and `amux project`.
- A plain-JavaScript npm CLI entrypoint so installed packages can run `amux` from `node_modules/.bin` without relying on Node TypeScript stripping.
- New projects now get a small default `WOW.md` with team norms for comments, review, waiting/reminders, and learnings.

### Changed

- All amux tools now register through framework-neutral `core/tools/*` definitions, making the Pi adapter thinner and reducing duplicated tool wiring.
- Task list/show defaults now use compact projections; pass `full:true` to retrieve verbose summaries, spec previews, and full comment/activity threads.
- Prompt context now uses compact journal previews and shorter coordination boilerplate.
- Assignment, task-comment, discussion, and lifecycle notifications now use shorter descriptive messages with pull-based detail references.
- `/amux` help and README now present canonical Project, Team, Work, Knowledge, and System surfaces while preserving existing shortcuts.
- `/amux context` and `/amux manage` are no longer part of the primary command model; use `/amux project vision ...`, `/amux project wow ...`, and `/amux new ...` instead.

## 1.2.0 (2026-06-22)

### Added

- **Hierarchical progress view**: `/amux progress` and `amux_task summary` render parent/child backlog structure with status markers and child progress counts.
- **Type-prefixed backlog IDs**: new items use prefixes such as `INIT-*`, `MS-*`, `BUG-*`, `CHORE-*`, `SPEC-*`, and `TASK-*` while preserving existing IDs.
- **Task-linked specs foundation**: backlog items can link first-class specs via `specPath`, with safe path helpers, templates, previews, and `plan`/`edit-plan` tool actions.
- **Task detail shortcut**: `/amux show <ITEM-ID>` displays backlog item details, comments, parent context, and spec preview.
- **Assignment attention recovery**: assigned-work nudges now handle stale `working` availability when the assignee has no active in-progress item.
- **Read-only CLI phase 1**: `amux progress`, `amux show`, `amux list`/`amux task list`, and `amux status` now use shared services/renderers.
- **Project vision**: `VISION.md` now states amux's goal of efficient communication, high alignment, and synergistic multi-agent collaboration.
- **First-class project vision/context interface**: `amux_project` and `/amux project vision ...` manage the prompt-injected project alignment artifact without direct file edits.
- **Team-state visibility and review handoff**: agent presence surfaces active/assigned work, and `amux_task review` marks implementation ready for review before final `done`.
- **Stale-aware direct messages**: `amux_send` messages now carry optional intent/task metadata and display sent age on delivery.
- **Reservation conflict context**: reservation warnings now show age, task linkage, owner work state, and task-comment guidance when possible.
- **Lightweight review handoff guidance**: review-ready items emphasize spec + diff + tests, with free-form handoff summaries instead of rigid schemas.
- **Productized benchmark harness**: `benchmarks/solo-vs-amux/` includes isolated solo-vs-team runs, scoring guidance, prompt templates, and analysis docs.
- **Project-local role profiles and team templates**: bundled `lead-architect`, `developer`, and `reviewer` role profiles plus the `core-team` template can be copied and customized per project.
- **Lead orchestration prompt assembly**: amux prompt composition is now a deliberate host-runtime-appended coordination block with common principles, role/profile, work, team, and interface sections.
- **Ways of Working**: project-specific `WOW.md` norms are prompt-injected after common principles and managed by `amux_wow` and `/amux wow ...`.
- **Team learning workflow**: README and lead role docs now describe lightweight retrospectives and `wow-proposal` journal learnings.
- **Prompt preview/debug surface**: `/amux prompt` shows a compact section summary, `/amux prompt <section>` previews focused sections, and `/amux prompt all` explicitly shows the full amux-appended block.
- **Compact prompt coordination snapshot**: teammate rows include task titles, and prompt team context includes open-work counts, review/blocked highlights, and active reservations.

### Changed

- Backlog guidance now treats initiatives/milestones as context containers and executable child items as assignable work.
- Agents can be assigned future leaf work up front; dependencies and pick flow gate when work actually starts.
- New project setup now guides users to set a project vision/context as the first alignment artifact.
- Nested Pi package metadata is aligned with the root package and declares ESM mode.
- Prompt preview and documentation use host-runtime wording for core behavior; Pi-specific wording is limited to adapter details.

### Fixed

- Avoid duplicate `projectArtifactsPath` barrel exports that could break extension loading.
- Added regression coverage to catch duplicate wildcard exports from `core/index.ts`.

## 1.1.0 (2026-06-20)

### Added

- **Configurable storage root**: `AMUX_SESSIONS_DIR` and `AMUX_HOME` are honored consistently by core and Pi adapter.
- **Safe file-backed writes**: coordinated JSON read-modify-write with lock files prevents lost updates across agents.
- **Agent identity hardening**: generated agent/message IDs now use UUIDs; agent names are unique per session, case-insensitively.
- **Heartbeat presence**: stale online agents expire after 90s and no longer block joins/reservations.
- **Agent availability**: agents can be `idle`, `working`, `focus`, or `away`; task lifecycle auto-updates availability where safe.
- **Generic attention signals**: idle agents receive coalesced state-change nudges without task details; task state remains authoritative.
- **Task-scoped discussion**: `amux_task show` and `amux_task comment` store per-task comment/activity history in `task-comments/<TASK-ID>.jsonl`.
- **State-derived task workflow**: task assignment no longer sends task-detail inbox messages; prompts/status derive current active/assigned task state.
- **Backlog structure foundation**: internal `BacklogItem` model with `itemType`, `parentId`, and `order` fields while preserving `Task` compatibility.
- **Task dependencies and batch assignment**: `dependsOn` gates picking, and comma-separated task IDs assign multiple items in one operation.
- **Direct setup shortcuts**: `/amux new project|agent|role` for agent-friendly project setup.
- **Project context commands**: `/amux context show|edit|set|append|clear|path` manages prompt-injected `CONTEXT.md`.
- **Workspace safety**: sanitized worktree branch names and workspace sync/status compare against `origin/<mainBranch>`.

### Changed

- Task-related coordination should use backlog state and task comments; `amux_send` is now documented as exceptional non-task communication.
- Reservation path matching is boundary-aware and handles workspace-relative normalization.
- Tests are portable via Node's built-in type stripping and no longer depend on hardcoded global Pi paths.

## 1.0.0 (2026-06-20)

Initial release.

### Features

- **Core module**: Pi-independent multi-agent coordination library
- **Agent registry**: UUID-based persistent agent identity (online/offline)
- **File-based messaging**: Crash-safe inbox system with fs.watch delivery
- **Task backlog**: Ordered queue with assign/pick/done and auto file reservation
- **File reservations**: Path-prefix locking with advisory warnings
- **Journal**: Append-only decision/learning log with sliding window prompt injection
- **Built-in roles**: developer, architect, reviewer, devops, planner
- **Git workspaces**: Worktree management per agent
- **Three-tier artifacts**: Project and private document sharing with CONTEXT.md auto-injection

### Pi Extension (amux-pi)

- 8 tools: amux_role, amux_list, amux_send, amux_broadcast, amux_artifacts, amux_reserve, amux_task, amux_journal
- Interactive commands: /amux (status, join, leave, manage, workspace)
- System prompt injection: role instructions, project context, journal, agent roster
- Crash-safe message delivery via pi.sendUserMessage()

### CLI

- Basic CLI skeleton (full implementation planned)
