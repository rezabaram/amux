# Benchmark Task 3: Show agent workspace health in progress view

## Goal

Add workspace-level git information (current branch, dirty file count) to the `/amutix progress` and `amutix_task summary` output so team leads can see at a glance whether agents have uncommitted work or are on unexpected branches.

## Requirements

- `/amutix progress` shows workspace info for online agents: branch name and number of dirty files.
- Information appears in a concise "Team" or "Agents" section of the progress view.
- Agents without workspaces show "(no workspace)" gracefully.
- Offline agents are excluded or marked as offline.
- The rendering should be in the shared renderers module, not inline in the Pi adapter.
- Implementation must handle git command failures gracefully (e.g., workspace directory deleted).
- `npm test` passes with new tests covering the renderer changes.

## Acceptance Criteria

1. [ ] Progress view includes per-agent workspace info (branch, dirty count)
2. [ ] Agents without workspaces handled gracefully
3. [ ] Offline agents excluded or clearly marked
4. [ ] Rendering logic in shared renderers (not Pi-only)
5. [ ] Git command failures don't crash the progress view
6. [ ] Tests cover renderer with/without workspace data
7. [ ] Tests pass

## Scoring Notes

- Full marks: all criteria met, clean renderer integration, graceful error handling
- Partial: workspace info shown but only in Pi adapter (not shared renderers)
- Zero: no workspace info or tests fail
