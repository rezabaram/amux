# Benchmark Scorecard Template

Copy this file for each benchmark run. Fill in results and scoring.

## Run Info

| Field | Value |
|-------|-------|
| Task | _e.g., Task 1: Add numeric priority_ |
| Arm | _solo / amutix_ |
| Model | _e.g., anthropic/claude-sonnet-4_ |
| Thinking | _e.g., high_ |
| Base commit | _hash_ |
| Date | _run date_ |
| Operator | _who ran the benchmark_ |

## Acceptance Criteria Scoring

Score each criterion from the task definition:

| # | Criterion | Met? | Notes |
|---|-----------|------|-------|
| 1 | _from task_ | ☐ Yes / ☐ No / ☐ Partial | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |
| 6 | | | |
| 7 | | | |

**Criteria met: _N_ / _total_**

## Quality Rubric

Score each dimension 0-3:

| Dimension | Score | Notes |
|-----------|-------|-------|
| **Correctness** (0-3) | | Does it work? Tests pass? Edge cases? |
| **Completeness** (0-3) | | All requirements addressed? Nothing missed? |
| **Code quality** (0-3) | | Follows patterns? Clean? Maintainable? |
| **Test coverage** (0-3) | | New behavior tested? Edge cases covered? |
| **Backward compat** (0-3) | | Existing data/tests unchanged? |

_Scoring: 0=not attempted, 1=major issues, 2=minor issues, 3=solid_

**Quality total: _N_ / 15**

## Token Measurement

| Metric | Value | Method |
|--------|-------|--------|
| Total tokens | | _exact / estimate / proxy_ |
| Architect tokens (amutix) | | |
| Developer tokens (amutix) | | |
| Reviewer tokens (amutix) | | |

**Measurement method**: _Describe how tokens were measured. See analysis-guide.md for caveats._

## Rework & Defects

| Issue | Severity | Tokens to fix (est.) | Notes |
|-------|----------|---------------------|-------|
| | _high/med/low_ | | |

## Failure Mode Annotations

Check any observed patterns (see analysis-guide.md for descriptions):

- ☐ **Broad context burn** — agent explored far beyond needed files
- ☐ **Lossy compression** — architect spec missed critical context, causing rework
- ☐ **Re-derivation** — agent reconstructed knowledge already in specs/journal/comments
- ☐ **Coordination overhead** — more tokens spent coordinating than saved by narrower context
- ☐ **Blind self-review** — solo agent missed issues that a separate reviewer would catch
- ☐ **Task scoping failure** — agent misunderstood scope, built wrong thing

## Verdict

| | |
|---|---|
| Winner | _solo / amutix / inconclusive_ |
| Quality score | _solo: N/15, amutix: N/15_ |
| Tokens | _solo: N, amutix: N_ |
| Quality per token | _solo: score/tokens, amutix: score/tokens_ |
| Justification | |
