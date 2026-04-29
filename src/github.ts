import { spawn } from "node:child_process"
import type {
  CommandFailure,
  CommandOptions,
  CommandResult,
  GitHubIssueSummary,
  GitHubIssueView,
  GitHubPullRequestSearchResult,
  GitHubPullRequestView,
  GitHubRepositorySearchItem,
} from "./types.js"

function collect(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
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

      const error = new Error(`Command failed: ${command} ${args.join(" ")}\n${stderr || stdout}`) as CommandFailure
      error.code = code
      error.stdout = stdout
      error.stderr = stderr
      reject(error)
    })
  })
}

export class GitHubClient {
  constructor(private readonly options: { dryRun?: boolean } = {}) {}

  async ensureAvailable(): Promise<void> {
    await collect("gh", ["--version"])
  }

  async api(
    path: string,
    { method = "GET", fields = {}, paginate = false, jq }: { method?: string; fields?: Record<string, string>; paginate?: boolean; jq?: string } = {},
  ): Promise<string> {
    const args = ["api"]

    if (paginate) {
      args.push("--paginate")
    }

    args.push(path, "--method", method)

    for (const [key, value] of Object.entries(fields)) {
      args.push("-F", `${key}=${value}`)
    }

    if (jq) {
      args.push("--jq", jq)
    }

    const { stdout } = await collect("gh", args)
    return stdout
  }

  async searchRepositories(query: string, limit = 10): Promise<GitHubRepositorySearchItem[]> {
    const { stdout } = await collect("gh", [
      "search",
      "repos",
      query,
      "--limit",
      String(limit),
      "--json",
      "name,owner,description,sshUrl,isArchived,isFork,stargazersCount,updatedAt,url,defaultBranch,primaryLanguage",
    ])

    return JSON.parse(stdout) as GitHubRepositorySearchItem[]
  }

  async listOpenIssues(owner: string, repo: string, limit = 30): Promise<GitHubIssueSummary[]> {
    const { stdout } = await collect("gh", [
      "issue",
      "list",
      "--repo",
      `${owner}/${repo}`,
      "--state",
      "open",
      "--limit",
      String(limit),
      "--json",
      "number,title,body,labels,comments,assignees,updatedAt,url,author",
    ])

    return JSON.parse(stdout) as GitHubIssueSummary[]
  }

  async viewIssue(owner: string, repo: string, number: number): Promise<GitHubIssueView> {
    const { stdout } = await collect("gh", [
      "issue",
      "view",
      String(number),
      "--repo",
      `${owner}/${repo}`,
      "--json",
      "number,title,body,labels,comments,assignees,updatedAt,url,author,projectItems,milestone,state",
    ])

    return JSON.parse(stdout) as GitHubIssueView
  }

  async searchIssuePrs(owner: string, repo: string, issueNumber: number): Promise<GitHubPullRequestSearchResult[]> {
    const { stdout } = await collect("gh", [
      "search",
      "prs",
      `${issueNumber} repo:${owner}/${repo} state:open`,
      "--limit",
      "20",
      "--json",
      "number,title,state,url,updatedAt,headRepositoryOwner,headRefName,baseRefName,isDraft",
    ])

    return JSON.parse(stdout) as GitHubPullRequestSearchResult[]
  }

  async forkRepo(owner: string, repo: string): Promise<{ name: string; owner: { login: string }; sshUrl: string; url: string }> {
    if (this.options.dryRun) {
      return {
        name: repo,
        owner: { login: owner },
        sshUrl: `git@github.com:${owner}/${repo}.git`,
        url: `https://github.com/${owner}/${repo}`,
      }
    }

    const { stdout } = await collect("gh", ["repo", "fork", `${owner}/${repo}`, "--clone=false", "--remote=false"])

    const forkUrl = stdout.trim().replace(/\.git$/, "")
    const match = forkUrl.match(/github\.com[:/](.+?)\/(.+)$/)
    const forkOwner = match?.[1]
    const forkRepo = match?.[2]

    if (!forkOwner || !forkRepo) {
      throw new Error(`Unable to parse gh repo fork output: ${stdout}`)
    }

    return {
      name: forkRepo,
      owner: { login: forkOwner },
      sshUrl: `git@github.com:${forkOwner}/${forkRepo}.git`,
      url: `https://github.com/${forkOwner}/${forkRepo}`,
    }
  }

  async authStatus(): Promise<string> {
    const { stdout, stderr } = await collect("gh", ["auth", "status"])
    return stdout || stderr
  }

  async prView(owner: string, repo: string, prUrl: string): Promise<GitHubPullRequestView> {
    const { stdout } = await collect("gh", [
      "pr",
      "view",
      prUrl,
      "--repo",
      `${owner}/${repo}`,
      "--json",
      "url,state,isDraft,title,body,headRefName,headRepositoryOwner,baseRefName,mergeable,number",
    ])

    return JSON.parse(stdout) as GitHubPullRequestView
  }
}
