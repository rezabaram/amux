# Changelog

## Unreleased

### Added

- New projects now get a small default `WOW.md` with sensible team norms for comments, review, waiting/reminders, and learnings.
- Task comments now notify relevant task subscribers by default, so assignees/participants wake and reassess task state without a separate `amux_send`.

### Removed

- Removed `/amux context` and `/amux manage` command surfaces from the primary command model. Use `/amux project vision ...` and `/amux new ...` instead.

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
