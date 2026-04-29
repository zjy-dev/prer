# prer

`prer` is a persistent OpenCode-based orchestrator that continuously:

- discovers valuable public GitHub repositories
- ranks worthwhile open code issues
- creates per-issue worktrees
- delegates implementation to the `prer` OpenCode subagent
- validates the returned pull request
- records progress under `records/`

## Requirements

The runtime depends on tools that are intentionally external to this repository:

- `node >= 22`
- `pnpm >= 9`
- `gh` authenticated against GitHub
- `git`
- `opencode`

Recommended setup:

```bash
pnpm install
pnpm bootstrap
gh auth login
opencode --version
```

## Run

```bash
pnpm build
pnpm start
```

For local iteration:

```bash
pnpm dev
```

Useful environment variables:

```bash
PRER_CONCURRENCY=2
PRER_POLL_INTERVAL_MS=30000
PRER_MODEL=openai/gpt-5
PRER_DRY_RUN=false
PRER_REPO_QUERY='stars:>=500 archived:false is:public language:TypeScript OR language:JavaScript OR language:Python'
```

## Layout

- `AGENTS.md`: root orchestrator instructions for the main OpenCode agent
- `.opencode/agents/prer.md`: implementation subagent definition
- `src/`: TypeScript orchestrator runtime
- `dist/`: compiled runtime output
- `repos/`: cloned fork repositories
- `worktrees/`: per-issue git worktrees
- `records/`: machine-parseable markdown tracking files
- `.tmp/`: temporary runtime files

## Notes

- Target repositories are handled with their native toolchain. This project does not force `pnpm` or `uv` on external OSS repositories.
- GitHub operations are performed with `gh`.
- Clone and remote configuration assume SSH access.
- Record files use one JSON object per markdown bullet so they remain both scriptable and readable.
