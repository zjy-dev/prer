import { constants } from "node:fs"
import { spawn } from "node:child_process"
import { access, mkdir } from "node:fs/promises"
import path from "node:path"
import type { CommandResult } from "./types.js"
import { worktreeName } from "./utils.js"

async function runGit(args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
        return
      }

      reject(new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr || stdout}`))
    })
  })
}

export class WorktreeManager {
  constructor(private readonly options: { worktreesDir: string; dryRun?: boolean }) {}

  async ensureBaseDirs(): Promise<void> {
    await mkdir(this.options.worktreesDir, { recursive: true })
  }

  worktreePath(owner: string, repo: string, issueNumber: number): string {
    return path.join(this.options.worktreesDir, worktreeName(owner, repo, issueNumber))
  }

  branchName(issueNumber: number, title: string): string {
    const suffix = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)

    return `prer/issue-${issueNumber}-${suffix || "work"}`
  }

  async create(params: {
    repoPath: string
    owner: string
    repo: string
    issueNumber: number
    title: string
    defaultBranch: string
  }): Promise<{ worktreePath: string; branchName: string }> {
    const branchName = this.branchName(params.issueNumber, params.title)
    const worktreePath = this.worktreePath(params.owner, params.repo, params.issueNumber)

    try {
      await access(worktreePath, constants.F_OK)
      return { worktreePath, branchName }
    } catch {
      // Create the worktree on demand below.
    }

    if (this.options.dryRun) {
      await mkdir(worktreePath, { recursive: true })
      return { worktreePath, branchName }
    }

    await runGit(["fetch", "upstream", params.defaultBranch], params.repoPath)
    await runGit(["worktree", "prune"], params.repoPath)
    await runGit(
      ["worktree", "add", "-B", branchName, worktreePath, `upstream/${params.defaultBranch}`],
      params.repoPath,
    )

    return { worktreePath, branchName }
  }
}
