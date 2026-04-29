import { constants } from "node:fs"
import { spawn } from "node:child_process"
import { access, mkdir } from "node:fs/promises"
import path from "node:path"
import type { CommandResult } from "./types.js"

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

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export class RepoManager {
  constructor(private readonly options: { reposDir: string; dryRun?: boolean }) {}

  repoPath(owner: string, repo: string): string {
    return path.join(this.options.reposDir, `${owner}__${repo}`)
  }

  async ensureBaseDirs(): Promise<void> {
    await mkdir(this.options.reposDir, { recursive: true })
  }

  async cloneIfNeeded(params: { upstreamOwner: string; repo: string; forkOwner: string }): Promise<string> {
    const repoPath = this.repoPath(params.upstreamOwner, params.repo)

    if (await exists(repoPath)) {
      await this.ensureRemotes({ repoPath, ...params })
      return repoPath
    }

    if (this.options.dryRun) {
      await mkdir(repoPath, { recursive: true })
      return repoPath
    }

    await runGit(["clone", `git@github.com:${params.forkOwner}/${params.repo}.git`, repoPath], this.options.reposDir)
    await this.ensureRemotes({ repoPath, ...params })
    return repoPath
  }

  async ensureRemotes(params: {
    repoPath: string
    upstreamOwner: string
    repo: string
    forkOwner: string
  }): Promise<void> {
    if (this.options.dryRun) {
      return
    }

    const remotes = await runGit(["remote", "-v"], params.repoPath)
    const lines = remotes.stdout.split("\n").filter(Boolean)

    const hasOrigin = lines.some((line) => line.startsWith("origin\t"))
    const hasUpstream = lines.some((line) => line.startsWith("upstream\t"))

    if (!hasOrigin) {
      await runGit(["remote", "add", "origin", `git@github.com:${params.forkOwner}/${params.repo}.git`], params.repoPath)
    } else {
      await runGit(["remote", "set-url", "origin", `git@github.com:${params.forkOwner}/${params.repo}.git`], params.repoPath)
    }

    if (!hasUpstream) {
      await runGit(["remote", "add", "upstream", `git@github.com:${params.upstreamOwner}/${params.repo}.git`], params.repoPath)
    } else {
      await runGit(["remote", "set-url", "upstream", `git@github.com:${params.upstreamOwner}/${params.repo}.git`], params.repoPath)
    }

    await runGit(["fetch", "upstream", "--prune"], params.repoPath)
    await runGit(["fetch", "origin", "--prune"], params.repoPath)
  }

  async defaultBranch(repoPath: string): Promise<string> {
    if (this.options.dryRun) {
      return "main"
    }

    const { stdout } = await runGit(["symbolic-ref", "refs/remotes/upstream/HEAD"], repoPath)
    const parts = stdout.split("/")
    return parts[parts.length - 1] || "main"
  }
}
