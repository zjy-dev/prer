# PRER Orchestrator Rules

This repository is an OpenCode-driven orchestrator that continuously finds valuable OSS repositories, selects worthwhile issues, and delegates implementation to the `prer` subagent.

## Mission

- Keep running without exiting unless a hard failure prevents progress.
- Focus on public GitHub repositories with at least 500 stars.
- Only choose issues that are code-related and worth fixing.
- Prefer issues with active discussion, recent updates, or clear user value.
- Never duplicate work already covered by an open pull request.

## Workspace Layout

- `src/` contains the orchestrator runtime.
- `.opencode/agents/prer.md` defines the implementation subagent.
- `repos/` stores cloned fork repositories. Each child is an independent nested git repository.
- `worktrees/` stores per-issue git worktrees.
- `records/` stores markdown tracking files, one per upstream repository.
- `.tmp/` stores transient runtime artifacts.

## Git and Repository Rules

- Treat every repository under `repos/` as a separate git repository.
- Never run broad git commands from the root that would confuse nested repositories.
- Clone with SSH URLs.
- In cloned repositories, keep `origin` pointing at the user's fork and `upstream` pointing at the original project.
- Create one worktree per issue under `worktrees/`.

## Issue Selection Rules

- Reject issues that are purely documentation, support, translation, design, or vague discussion.
- Reject issues that obviously require unavailable external credentials or infrastructure.
- Reject issues with an existing open PR that already addresses the issue.
- Prefer minimal, high-leverage fixes over speculative large rewrites.

## Subagent Delegation Rules

- Delegate only one concrete issue per `prer` session.
- Default concurrency is 2.
- Require the subagent to run relevant validation before opening a PR.
- Require a PR URL or a precise blocked reason in the subagent result.
- If a submitted PR is invalid, send the work back unless the subagent has demonstrated a real blocker.

## Tooling Rules

- GitHub interactions should use `gh`.
- Target repositories should use their native toolchain for build and test.
- When adding or updating this repository's own dependencies, prefer `pnpm`.
- Keep code comments focused and useful. Comment complex blocks, not every line.

## Record Format

- Maintain `records/<owner>__<repo>.md` as an unordered markdown list.
- Each line should be machine-parseable and human-readable.
- Include issue number, title, URL, score, assignment state, worktree path, PR URL, timestamp, and note.
