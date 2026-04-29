import path from "node:path"
import type { PrerConfig } from "./types.js"

function readNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase())
}

export function loadConfig(): PrerConfig {
  const rootDir = process.cwd()
  const pollIntervalMs = readNumber(process.env.PRER_POLL_INTERVAL_MS, 30_000)
  const concurrency = readNumber(process.env.PRER_CONCURRENCY, 2)
  const opencodeBin = process.env.OPENCODE_BIN || "opencode"
  const model = process.env.PRER_MODEL || undefined
  const providerId = process.env.PRER_PROVIDER_ID || undefined
  const modelId = process.env.PRER_MODEL_ID || undefined

  return {
    rootDir,
    reposDir: path.join(rootDir, "repos"),
    worktreesDir: path.join(rootDir, "worktrees"),
    recordsDir: path.join(rootDir, "records"),
    tempDir: path.join(rootDir, ".tmp"),
    agentConfigDir: path.join(rootDir, ".opencode"),
    pollIntervalMs,
    concurrency,
    opencodeBin,
    model,
    providerId,
    modelId,
    logLevel: process.env.PRER_LOG_LEVEL || "info",
    dryRun: readBoolean(process.env.PRER_DRY_RUN, false),
    githubSearchQuery:
      process.env.PRER_REPO_QUERY ||
      "stars:>=500 archived:false is:public language:TypeScript OR language:JavaScript OR language:Python",
  }
}
