# Benchmark Task 2: Add backlog item reordering

## Goal

Add the ability to reorder backlog items so planners can adjust priorities without re-creating items. The backlog is currently ordered by insertion time; items need a way to be moved to a different position.

## Requirements

- Add an `amutix_task` action (e.g., `move`) that repositions an item within the backlog.
- Accept a target position or relative movement (e.g., "before TASK-03" or "to position 2").
- The new order persists across reads/writes.
- Child items (with `parentId`) maintain their parent association when moved.
- `amutix_task list` reflects the new order.
- `/amutix progress` reflects the new order.
- `npm test` passes with new tests covering reorder behavior.

## Acceptance Criteria

1. [ ] A reorder/move action exists on `amutix_task`
2. [ ] Items can be repositioned by ID
3. [ ] New order persists in `backlog.json`
4. [ ] List display reflects updated order
5. [ ] Progress view reflects updated order
6. [ ] Parent-child relationships preserved during move
7. [ ] Tests added and passing

## Scoring Notes

- Full marks: move action works, order persists, all displays updated, tests pass
- Partial: move works but only some displays updated
- Zero: no reorder capability or tests fail
