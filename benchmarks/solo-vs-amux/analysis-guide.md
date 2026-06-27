# Benchmark Analysis Guide

How to interpret solo-vs-amutix benchmark results honestly.

## Primary Metric: Quality per Token

The goal is **verified quality per token**, not raw token counts. A team that uses more tokens but produces correct, complete, well-tested code beats a solo agent that uses fewer tokens but misses requirements.

```
quality_per_token = quality_score / total_tokens
```

Quality score comes from the scorecard rubric (0-15). Total tokens are the sum across all agents for the amutix arm.

## Token Measurement Caveats

**Do not claim efficiency from proxy measurements.**

| Method | Reliability | How |
|--------|------------|-----|
| Provider dashboard | High | Check API usage for the session period |
| Pi session JSON | Medium | If Pi records token usage in session data |
| Transcript estimate | Low | Count characters in full agent transcript ÷ 4 |
| Stdout chars ÷ 4 | Very low | Only measures output, not input context |

Always state the measurement method in the scorecard. Results from different methods are not comparable.

## Failure Modes to Watch

### Broad Context Burn
The solo agent explores the full codebase when only 3-4 files are relevant. Symptoms: reading files not in the eventual diff, long exploration phases before making changes. This is the primary cost the architect role is supposed to eliminate — the architect reads broadly once and compresses into a spec.

### Lossy Compression
The architect's spec omits critical context. The developer makes wrong assumptions, asks clarifying questions, or produces incorrect code. The rework tokens often exceed what the developer would have spent reading the codebase directly. Watch for: developer deviating from spec, unexpected file changes not in spec, test failures from incorrect assumptions.

### Re-derivation
An agent reconstructs knowledge that already exists in amutix state (specs, journal entries, task comments, previous task summaries). Symptoms: agent reasons through a decision that was already recorded, re-reads files that a spec already summarized. This indicates the compression layer isn't being used effectively.

### Coordination Overhead
The amutix team spends more tokens on coordination (reading task state, writing comments, updating specs) than they save from narrower context. Most likely on small tasks where the architect's broad read + spec writing costs more than the developer saves. Watch for: architect spec longer than the eventual code change.

### Blind Self-Review
The solo agent misses issues that a separate reviewer would catch. Symptoms: tests pass but requirements are partially unmet, edge cases missed, code quality issues. This is the primary value of the reviewer role — catching blind spots the implementer can't see.

### Task Scoping Failure
The agent misunderstands the scope of the task. Builds something adjacent but not what was asked for. More likely in solo mode where there's no architect to constrain scope, but can also happen in amutix mode if the architect's spec is ambiguous.

## Interpreting Results

### Amux wins when:
- Quality scores are comparable or higher AND total tokens are lower
- The architect's spec genuinely saved the developer from broad context discovery
- The reviewer caught issues the implementer missed
- Tasks were complex enough that role specialization added value

### Solo wins when:
- The task is small enough that one agent can hold full context cheaply
- The architect's spec added overhead without saving the developer enough
- The coordination cost exceeded the compression benefit
- Quality was comparable with fewer total tokens

### Inconclusive when:
- Token measurement methods differ between arms
- Quality scores are very close (within 1-2 points)
- External factors affected the run (model errors, timeout, etc.)

## What NOT to Claim

- Do not claim amutix is "more efficient" from a single task comparison.
- Do not claim token savings from proxy measurements.
- Do not compare runs with different models or thinking modes.
- Do not ignore rework costs — include them in total tokens.
- A benchmark shows a specific scenario, not a general truth.
