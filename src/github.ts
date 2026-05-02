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
      "name,owner,description,isArchived,isFork,stargazersCount,updatedAt,url,defaultBranch,language",
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
      "api",
      `search/issues?q=${issueNumber}+repo:${owner}/${repo}+type:pr+state:open&per_page=20`,
      "--jq",
      ".items[] | {number, title, state, url: .html_url, updatedAt: .updated_at, isDraft: .draft}",
    ])

    return stdout.trim() ? (stdout.trim().split("\n").map(line => JSON.parse(line))) : []
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

    const { stdout: loginOut } = await collect("gh", ["api", "user", "--jq", ".login"])
    const login = loginOut.trim()

    try {
      const result = await collect("gh", ["repo", "fork", `${owner}/${repo}`, "--clone=false"])
      const forkUrl = result.stdout.trim() || result.stderr.trim()

      const match = forkUrl.match(/github\.com[/:](.+?)\/(.+?)(?:\.git)?$/)
      if (match) {
        return {
          name: match[2],
          owner: { login: match[1] },
          sshUrl: `git@github.com:${match[1]}/${match[2]}.git`,
          url: `https://github.com/${match[1]}/${match[2]}`,
        }
      }
    } catch {
      // fork may already exist
    }

    const { stdout: repoOut } = await collect("gh", ["api", `repos/${login}/${repo}`, "--jq", ".html_url"])
    const existingUrl = repoOut.trim()
    if (existingUrl) {
      return {
        name: repo,
        owner: { login },
        sshUrl: `git@github.com:${login}/${repo}.git`,
        url: existingUrl,
      }
    }

    throw new Error(`Unable to fork or find existing fork for ${owner}/${repo}`)
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
