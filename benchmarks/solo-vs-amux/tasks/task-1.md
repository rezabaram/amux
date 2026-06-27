# Benchmark Task 1: Add numeric priority to backlog items

## Goal

Add an optional numeric priority field to backlog items so teams can express urgency beyond simple list ordering. Higher priority items should appear first in relevant displays.

## Requirements

- Backlog items can have an optional `priority` field (numeric, higher = more urgent).
- The `amutix_task add` tool accepts an optional `priority` parameter.
- `amutix_task list` displays priority when set and sorts by priority before backlog position.
- Auto-pick (`amutix_task pick` without ID) considers priority: higher-priority items before lower.
- `/amutix progress` reflects priority ordering in the "Next" section.
- Existing items without priority continue to work unchanged.
- `npm test` passes with new tests covering priority behavior.

## Acceptance Criteria

1. [ ] `priority?: number` field exists on BacklogItem
2. [ ] `amutix_task add` accepts optional priority
3. [ ] `amutix_task list` sorts by priority (descending) within each status group
4. [ ] Auto-pick prefers higher-priority items
5. [ ] Progress "Next" section respects priority
6. [ ] Backward compatible — existing items work unchanged
7. [ ] Tests added and passing

## Scoring Notes

- Full marks: all criteria met, clean implementation, tests pass
- Partial: priority stored but not used in pick/list ordering
- Zero: priority not implemented or tests fail
