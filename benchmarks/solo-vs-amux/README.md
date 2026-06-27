# Solo vs Amux Benchmark

Compare solo-agent and amutix-team workflows on quality-per-token for realistic multi-file tasks.

## Quick Start

```bash
# 1. Prepare workspace
benchmarks/solo-vs-amutix/bench.sh prepare

# 2. Set up a solo run for task 1, then run the generated script
benchmarks/solo-vs-amutix/bench.sh run-solo 1
/tmp/amutix-bench/solo-task-1/run-solo.sh

# 3. Set up an amutix-style run for task 1, then run the generated scripts in order
benchmarks/solo-vs-amutix/bench.sh run-amutix 1
/tmp/amutix-bench/amutix-task-1/run-architect.sh
/tmp/amutix-bench/amutix-task-1/run-developer.sh
/tmp/amutix-bench/amutix-task-1/run-reviewer.sh

# 4. If a run gets stuck, stop benchmark processes under BENCH_ROOT
benchmarks/solo-vs-amutix/bench.sh stop

# 5. After running each arm, collect results
benchmarks/solo-vs-amutix/bench.sh collect solo 1
benchmarks/solo-vs-amutix/bench.sh collect amutix 1

# 6. Generate report
benchmarks/solo-vs-amutix/bench.sh report
```

## How It Works

The harness creates **isolated git clones** at a fixed base commit. The solo arm gets one workspace. The amutix-style arm gets one shared sequential workspace so the architect can leave `SPEC.md`, the developer can implement and leave `HANDOFF.md`, and the reviewer can inspect the actual diff/test output. None of these workspaces mutate the source repo.

**Solo arm**: A single agent receives the task description and works independently — discovers the codebase, designs the approach, implements, and tests.

**Amux arm**: Three agents work sequentially:
1. **Architect** reads the codebase and writes a compact spec/plan (target 100-150 lines) as compressed intent
2. **Developer** implements from the spec without re-reading the full codebase
3. **Reviewer** checks the implementation against the spec and acceptance criteria

## Configuration

Override via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `BENCH_ROOT` | `/tmp/amutix-bench` | Workspace root |
| `SRC_REPO` | repo root | Source repo to clone |
| `BASE_COMMIT` | `HEAD` | Starting commit for all arms |
| `PI_BIN` | `pi` | Pi binary path |
| `PI_PROVIDER` | _(none)_ | Pin provider (e.g., `deepseek`) |
| `PI_MODEL` | _(none)_ | Pin model (e.g., `deepseek/deepseek-v4-pro`) |
| `PI_THINKING` | _(none)_ | Thinking mode (e.g., `high`) |
| `BENCH_TIMEOUT_SECONDS` | `0` | Optional per-agent timeout; `0` disables timeout |

## Tasks

See `tasks/` for benchmark task definitions. Each task describes:
- A high-level goal (not pre-scoped file lists)
- Requirements and acceptance criteria
- Scoring rubric

## Token Measurement

The harness collects diffs, test output, commits, terminal logs, and isolated Pi session files under `$BENCH_ROOT/pi-sessions`. Token measurement is still **manual** — check your provider's dashboard or Pi session logs.

**Honest measurement order** (from SPEC-10):
1. Exact provider/Pi token usage from the isolated session files or provider dashboard (preferred)
2. Full transcript token estimate
3. Stdout chars/4 as last-resort proxy (clearly labelled)

The report must state which method was used. Do not claim efficiency without exact/fair measurement.

## Analysis & Scoring

- **[scorecard-template.md](scorecard-template.md)** — Copy per run. Quality rubric (0-15), acceptance criteria checklist, token measurement, rework tracking, failure-mode annotations.
- **[analysis-guide.md](analysis-guide.md)** — How to interpret results: failure modes, token measurement caveats, what NOT to claim.
- **[worked-example.md](worked-example.md)** — Lessons from the initial pilot run.

## Limitations

- Runs are semi-manual — the harness prepares workspaces and executable Pi scripts, but the operator still runs each arm and records exact provider token usage externally when needed.
- Generated Pi scripts use isolated session storage, not `--no-session`, so local session logs can be inspected without contaminating normal Pi history.
- Token measurement depends on provider/session tooling, not only the harness.
- Tasks are designed for the amutix codebase; results may not generalize.
- The amutix arm has coordination overhead; small tasks may not show compression benefit.
- Quality scoring is manual (see `scorecard-template.md`).

## File Layout

```
benchmarks/solo-vs-amutix/
  bench.sh                  Harness script
  README.md                 This file
  tasks/                    Task definitions
    task-1.md               Priority field
    task-2.md               Backlog reordering
    task-3.md               Workspace health in progress
  prompt-templates/         Role-specific prompts
    solo.md                 Solo agent prompt
    architect.md            Architect prompt
    developer.md            Developer prompt
    reviewer.md             Reviewer prompt
  scorecard-template.md     Quality scoring rubric and template
  analysis-guide.md         Interpretation guide and failure modes
  worked-example.md         Lessons from initial pilot
```
