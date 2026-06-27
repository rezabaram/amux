# Solo Agent Benchmark Prompt

You are a solo software engineer working on the amutix codebase. You must complete the task below independently — design the approach, implement the changes, write tests, and verify correctness.

## Context

- This is a Node.js TypeScript project using `--experimental-strip-types` (Node >= 22).
- Zero runtime dependencies — only Node.js built-in modules.
- Run `npm test` to verify all tests pass.
- Read existing code to understand patterns before making changes.
- The project has: `core/` (framework-agnostic), `pi/` (Pi extension), `cli/` (CLI), `test/` (tests).

## Constraints

- Do not add runtime dependencies.
- Preserve backward compatibility with existing data files.
- Follow existing code patterns and conventions.
- All existing tests must continue to pass.
- Add new tests for your changes.
