# Worked Example: Pilot Benchmark Lessons

Based on the initial `/tmp/amutix-bench` pilot run. This is NOT a rigorous result — it documents what we learned about the harness and methodology.

## Pilot Setup

- **Task**: Add reservation stale/offline coverage to the amutix codebase
- **Model**: deepseek/deepseek-v4-pro (thinking: high)
- **Base commit**: pre-TASK-35 hardening
- **Token measurement**: stdout chars ÷ 4 (last-resort proxy — NOT reliable for claims)

## What Happened

### Solo Arm
The solo agent:
- Explored the codebase broadly, reading many files to understand the architecture
- Identified the relevant modules (registry, reservations, Pi adapter)
- Implemented the changes with tests
- Missed some edge cases that a separate reviewer would have caught

### Amux Arm
- **Architect**: Read the codebase, identified the reservation conflict detection gap, wrote a spec listing files and approach
- **Developer**: Implemented from the spec, focused on the listed files
- **Reviewer**: Checked the diff against the spec, found coverage gaps

## Key Observations

### 1. Tasks were too small
The pilot task was narrow enough that the solo agent could hold the full context cheaply. The architect's spec added overhead without significantly narrowing the developer's context. **Lesson: benchmark tasks need to be larger and more ambiguous to force genuine context discovery costs.**

### 2. Token proxy is unreliable
Stdout characters ÷ 4 only measures output tokens. It misses input context (which is often 80%+ of total tokens). **Lesson: use provider dashboard or Pi session JSON for real measurement.**

### 3. Amux quality advantage was real but narrow
The reviewer caught a stale-reservation edge case the solo agent missed. But the quality difference was small — maybe 1 point on a 15-point rubric. **Lesson: quality scoring needs to weight requirement completeness heavily.**

### 4. Coordination overhead is visible
The architect's spec, the cross-workspace file copying, and the reviewer's setup all consumed tokens that the solo agent didn't need. On small tasks, this overhead dominated. **Lesson: the compression benefit must exceed the coordination cost, which only happens on larger tasks.**

## Pilot Scorecard (Illustrative)

| Metric | Solo | Amux |
|--------|------|------|
| Criteria met | 5/7 | 6/7 |
| Quality score | 10/15 | 12/15 |
| Token proxy (unreliable) | ~8K chars | ~14K chars total |
| Quality/token | 1.25/K | 0.86/K |
| Verdict | — | — |

**Verdict: Inconclusive.** Token measurement was proxy-only. Quality advantage was real but small. Task was too narrow to test the compression thesis. Larger tasks with exact token measurement needed.

## What Changed for v2

Based on pilot lessons:
1. Tasks are now larger, multi-module, and deliberately ambiguous
2. Scorecard includes failure-mode annotations
3. Analysis guide documents honest measurement requirements
4. Harness explicitly warns against proxy-based efficiency claims
