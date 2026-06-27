# Contributing to amutix

Thank you for your interest in contributing to amutix!

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/amutix.git`
3. Create a branch: `git checkout -b feature/my-feature`
4. Make your changes
5. Run tests: `npm test`
6. Commit: `git commit -m "feat: add my feature"`
7. Push: `git push origin feature/my-feature`
8. Open a Pull Request

## Project Structure

```
amutix/
├── core/       Core library (Pi-independent, framework-agnostic)
├── pi/         Pi extension (tools, commands, prompt injection)
├── cli/        Command-line interface
└── test/       Tests
```

## Guidelines

- **Core module** (`core/`) must remain Pi-independent. No imports from Pi packages.
- **Pi extension** (`pi/`) is the only place for Pi-specific code.
- Run `npm test` before submitting — it verifies all files parse correctly and runs E2E flow tests.
- Follow existing code patterns (atomic file writes, consistent error handling).
- Keep the tool count minimal. Consolidate with action enums when possible.

## Commit Convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation
- `refactor:` code change that neither fixes a bug nor adds a feature
- `test:` adding tests
- `chore:` maintenance

## Reporting Issues

Use GitHub Issues. Include:
- What you expected
- What happened
- Steps to reproduce
- Your environment (Node.js version, Pi version if using the extension)
