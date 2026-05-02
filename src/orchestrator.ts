import { mkdir } from "node:fs/promises"
import { loadConfig } from "./config.js"
import { GitHubClient } from "./github.js"
import { OpencodeRuntime, createSession, listAgents, promptSession } from "./opencode-client.js"
import { RecordManager } from "./records.js"
import { RepoManager } from "./repos.js"
import { WorktreeManager } from "./worktrees.js"
import type {
  DiscoveredIssueInput,
  GitHubIssueView,
  GitHubPullRequestView,
  GitHubRepositorySearchItem,
  IssueCandidate,
  IssueRecordEntry,
  ModelSelection,
  OpenCodePromptResult,
  PrerConfig,
  PrerResult,
  ProjectCandidate,
  ValidationResult,
  WorkerQueueItem,
} from "./types.js"
import { countComments, dedent, nowIso, projectKey, safeJsonParse, sleep } from "./utils.js"

function log(level: string, message: string, extra?: string): void {
  const prefix = `[${nowIso()}] [${level.toUpperCase()}]`
  if (extra === undefined) {
    console.log(prefix, message)
    return
  }

  console.log(prefix, message, extra)
}

function randomPort(base = 4100): number {
  return base + Math.floor(Math.random() * 2000)
}

function extractText(parts: OpenCodePromptResult["parts"] = []): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n")
}

function extractStructured<T>(response: OpenCodePromptResult): T | undefined {
  return (response.info?.structured as T | undefined) ?? (response.info?.structured_output as T | undefined)
}

function isRetryReady(entry: IssueRecordEntry, retryDelayMs: number, now = Date.now()): boolean {
  if (entry.status === "queued") {
    return true
  }

  if (entry.status !== "redo") {
    return false
  }

  const updatedAt = entry.updatedAt ? Date.parse(entry.updatedAt) : Number.NaN
  if (!Number.isFinite(updatedAt)) {
    return true
  }

  return now - updatedAt >= retryDelayMs
}

function normalizeRepository(
  repository: Partial<ProjectCandidate> & { owner?: { login: string } | string | null; repo?: string; name?: string },
): ProjectCandidate {
  const ownerValue = repository.owner
  let owner = ""
  if (typeof ownerValue === "string") {
    owner = ownerValue
  } else if (ownerValue && typeof ownerValue === "object" && "login" in ownerValue) {
    owner = (ownerValue as { login: string }).login
  }
  const repo = repository.repo || repository.name || ""

  return {
    owner,
    repo,
    reason: repository.reason || "",
    stars: repository.stars || 0,
    url: repository.url || (owner && repo ? `https://github.com/${owner}/${repo}` : ""),
    defaultBranch: repository.defaultBranch || "main",
    updatedAt: repository.updatedAt,
    description: repository.description,
    language: repository.language,
    name: repository.name,
  }
}

function normalizeIssue(issue: Partial<IssueCandidate> & { number?: number; url?: string }): IssueCandidate {
  return {
    issueNumber: issue.issueNumber || issue.number || 0,
    title: issue.title || "",
    issueUrl: issue.issueUrl || issue.url || "",
    score: issue.score || 0,
    note: issue.note || "",
  }
}

function resolveModelSelection(config: PrerConfig): ModelSelection | undefined {
  if (config.providerId && config.modelId) {
    return {
      providerID: config.providerId,
      modelID: config.modelId,
    }
  }

  if (!config.model || !config.model.includes("/")) {
    return undefined
  }

  const [providerID, ...rest] = config.model.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) {
    return undefined
  }

  return { providerID, modelID }
}

export class Orchestrator {
  private readonly github: GitHubClient
  private readonly repoManager: RepoManager
  private readonly worktreeManager: WorktreeManager
  private readonly recordManager: RecordManager
  private readonly activeWorkers = new Map<string, Promise<void>>()
  private readonly modelSelection: ModelSelection | undefined
  private readonly retryDelayMs = 5 * 60_000
  private rootRuntime: OpencodeRuntime | null = null
  private rootClient: Awaited<ReturnType<OpencodeRuntime["start"]>> | null = null
  private rootSessionId: string | null = null
  private started = false

  constructor(private readonly config: PrerConfig = loadConfig()) {
    this.github = new GitHubClient({ dryRun: config.dryRun })
    this.repoManager = new RepoManager({ reposDir: config.reposDir, dryRun: config.dryRun })
    this.worktreeManager = new WorktreeManager({ worktreesDir: config.worktreesDir, dryRun: config.dryRun })
    this.recordManager = new RecordManager({ recordsDir: config.recordsDir })
    this.modelSelection = resolveModelSelection(config)
  }

  async prepare(): Promise<void> {
    await mkdir(this.config.tempDir, { recursive: true })
    await this.repoManager.ensureBaseDirs()
    await this.worktreeManager.ensureBaseDirs()
    await this.recordManager.ensureBaseDirs()
    await this.github.ensureAvailable()
    await this.ensureRootRuntime()
    await this.recoverQueuedWork()
  }

  async ensureRootRuntime(): Promise<void> {
    if (this.rootClient && this.rootSessionId) {
      try {
        await this.rootClient.global.health()
        return
      } catch {
        await this.shutdown()
      }
    }

    const runtime = new OpencodeRuntime({
      opencodeBin: this.config.opencodeBin,
      cwd: this.config.rootDir,
      port: randomPort(6200),
      configDir: this.config.agentConfigDir,
      hostname: "127.0.0.1",
    })

    const client = await runtime.start()
    await listAgents(client).catch(() => undefined)
    const session = await createSession(client, "prer orchestrator")

    this.rootRuntime = runtime
    this.rootClient = client
    this.rootSessionId = session.id
  }

  async recoverQueuedWork(): Promise<void> {
    const projects = await this.recordManager.listProjects()

    for (const project of projects) {
      const entries = await this.recordManager.read(project.owner, project.repo)
      for (const entry of entries) {
        if (entry.status === "running") {
          await this.recordManager.upsert(project.owner, project.repo, {
            ...entry,
            status: "queued",
            assignedTo: "",
            note: "recovered from interrupted run",
          })
        }
      }
    }
  }

  async run(): Promise<void> {
    if (!this.started) {
      await this.prepare()
      this.started = true
    }

    while (true) {
      try {
        await this.tick()
      } catch (error) {
        const message = error instanceof Error ? error.stack || error.message : String(error)
        log("error", "Orchestrator tick failed", message)
      }

      await sleep(this.config.pollIntervalMs)
    }
  }

  async tick(): Promise<void> {
    log("info", "Starting orchestration tick")
    await this.scheduleRecordedWork()

    const freeSlots = Math.max(0, this.config.concurrency - this.activeWorkers.size)
    if (freeSlots <= 0) {
      log("info", `Worker pool full at ${this.activeWorkers.size}`)
      return
    }

    const project = await this.selectProject()
    if (!project) {
      log("warn", "No candidate repository selected this tick")
      return
    }

    await this.ensureProjectQueue(project)
    await this.scheduleRecordedWork(project)

    if (this.activeWorkers.size > 0) {
      log("info", `Active workers: ${this.activeWorkers.size}`)
    }
  }

  async scheduleRecordedWork(project: ProjectCandidate | null = null): Promise<void> {
    const queue = await this.collectQueuedEntries(project)
    const freeSlots = Math.max(0, this.config.concurrency - this.activeWorkers.size)

    for (const item of queue.slice(0, freeSlots)) {
      const key = `${projectKey(item.owner, item.repo)}#${item.entry.issueNumber}`
      if (this.activeWorkers.has(key)) {
        continue
      }

      const workerPromise = this.runIssue(item.project, item.entry)
        .catch((error) => {
          const message = error instanceof Error ? error.stack || error.message : String(error)
          log("error", `Worker crashed for ${key}`, message)
        })
        .finally(() => {
          this.activeWorkers.delete(key)
        })

      this.activeWorkers.set(key, workerPromise)
    }
  }

  async collectQueuedEntries(project: ProjectCandidate | null = null): Promise<WorkerQueueItem[]> {
    const targets: Array<{ owner: string; repo: string; project: ProjectCandidate }> = []

    if (project) {
      targets.push({ owner: project.owner, repo: project.repo, project })
    } else {
      const projects = await this.recordManager.listProjects()
      targets.push(
        ...projects.map((item) => ({
          owner: item.owner,
          repo: item.repo,
          project: { owner: item.owner, repo: item.repo, reason: "", stars: 0, url: "", defaultBranch: "" },
        })),
      )
    }

    const queue: WorkerQueueItem[] = []
    for (const target of targets) {
      const entries = await this.recordManager.read(target.owner, target.repo)
      for (const entry of entries) {
        if (isRetryReady(entry, this.retryDelayMs)) {
          queue.push({ ...target, entry })
        }
      }
    }

    queue.sort((left, right) => right.entry.score - left.entry.score)
    return queue
  }

  async selectProject(): Promise<ProjectCandidate | null> {
    const repositories = await this.github.searchRepositories(this.config.githubSearchQuery, 10)
    const trackedProjects = new Set(
      (await this.recordManager.listProjects()).map((item) => projectKey(item.owner, item.repo)),
    )

    const candidates = repositories
      .filter((repo) => !repo.isArchived && !repo.isFork)
      .map((repo: GitHubRepositorySearchItem) => ({
        owner: repo.owner.login,
        repo: repo.name,
        name: repo.name,
        url: repo.url,
        stars: repo.stargazersCount,
        defaultBranch: repo.defaultBranch,
        updatedAt: repo.updatedAt,
        description: repo.description || "",
        language: repo.language || "",
        reason: "",
      }))
      .sort((left, right) => {
        const leftTracked = trackedProjects.has(projectKey(left.owner, left.repo)) ? 1 : 0
        const rightTracked = trackedProjects.has(projectKey(right.owner, right.repo)) ? 1 : 0
        if (leftTracked !== rightTracked) {
          return leftTracked - rightTracked
        }

        return right.stars - left.stars
      })

    if (candidates.length === 0) {
      return null
    }

    const agentChoice = await this.askRootAgentForProject(candidates)
    if (agentChoice) {
      return agentChoice
    }

    return normalizeRepository(candidates[0])
  }

  async askRootAgentForProject(candidates: ProjectCandidate[]): Promise<ProjectCandidate | null> {
    if (!this.rootClient || !this.rootSessionId) {
      throw new Error("Root OpenCode runtime is not ready")
    }

    const prompt = dedent(`
      Select the most valuable OSS repository for autonomous issue fixing.

      Constraints:
      - public GitHub repo
      - at least 500 stars
      - code-heavy, not docs-only or resource-only
      - likely to have tractable, user-valuable open issues

      Return only JSON with this schema:
      {
        "owner": "string",
        "repo": "string",
        "reason": "string"
      }

      Candidates:
      ${JSON.stringify(candidates, null, 2)}
    `)

    const response = await promptSession(this.rootClient, this.rootSessionId, {
      agent: "build",
      model: this.modelSelection,
      parts: [{ type: "text", text: prompt }],
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            reason: { type: "string" },
          },
          required: ["owner", "repo", "reason"],
        },
      },
    })

    const structured = extractStructured<Partial<ProjectCandidate>>(response) || safeJsonParse<Partial<ProjectCandidate>>(extractText(response.parts || []))

    if (!structured) {
      return null
    }

    const match = candidates.find(
      (candidate) => candidate.owner === structured.owner && candidate.repo === structured.repo,
    )

    if (!match) {
      return null
    }

    return normalizeRepository({ ...match, reason: structured.reason || "" })
  }

  async ensureProjectQueue(project: ProjectCandidate): Promise<void> {
    const currentEntries = await this.recordManager.read(project.owner, project.repo)
    const unfinished = currentEntries.some((entry) => ["queued", "running", "redo"].includes(entry.status))
    if (unfinished) {
      return
    }

    const seenIssueNumbers = new Set(currentEntries.map((entry) => entry.issueNumber))
    const discoveredIssues = await this.discoverIssues(project)

    for (const issue of discoveredIssues) {
      if (seenIssueNumbers.has(issue.issueNumber)) {
        continue
      }

      await this.recordManager.upsert(project.owner, project.repo, {
        status: "queued",
        issueNumber: issue.issueNumber,
        title: issue.title,
        issueUrl: issue.issueUrl,
        score: issue.score,
        assignedTo: "",
        worktreePath: "",
        prUrl: "",
        note: issue.note,
        branchName: "",
        commitSha: "",
        verification: [],
        lastError: "",
      })
    }
  }

  async discoverIssues(project: ProjectCandidate): Promise<IssueCandidate[]> {
    const issues = await this.github.listOpenIssues(project.owner, project.repo, 25)
    const basicCandidates: DiscoveredIssueInput[] = []

    for (const issue of issues) {
      const lowerTitle = issue.title.toLowerCase()
      const lowerBody = (issue.body || "").toLowerCase()
      const looksCodeRelated =
        /(bug|feature|implement|crash|panic|error|refactor|performance|add|allow|handle|fix|support)/.test(
          `${lowerTitle} ${lowerBody}`,
        )
      const excluded = /(docs|documentation|translation|typo|question|support request|design)/.test(
        `${lowerTitle} ${lowerBody}`,
      )

      if (!looksCodeRelated || excluded) {
        continue
      }

      const openPrs = await this.github.searchIssuePrs(project.owner, project.repo, issue.number)
      if (openPrs.length > 0) {
        continue
      }

      basicCandidates.push({
        number: issue.number,
        title: issue.title,
        url: issue.url,
        body: issue.body || "",
        updatedAt: issue.updatedAt,
        labels: issue.labels.map((label) => label.name),
        comments: countComments(issue.comments),
      })
    }

    if (basicCandidates.length === 0) {
      return []
    }

    const agentRanked = await this.askRootAgentForIssues(project, basicCandidates)
    if (agentRanked.length > 0) {
      return agentRanked.map(normalizeIssue)
    }

    return basicCandidates
      .map((issue) => ({
        issueNumber: issue.number,
        title: issue.title,
        issueUrl: issue.url,
        score: 5 + issue.comments * 1.5 + issue.labels.length,
        note: `fallback ranking; updated=${issue.updatedAt}`,
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 6)
  }

  async askRootAgentForIssues(project: ProjectCandidate, issues: DiscoveredIssueInput[]): Promise<IssueCandidate[]> {
    if (!this.rootClient || !this.rootSessionId) {
      throw new Error("Root OpenCode runtime is not ready")
    }

    const prompt = dedent(`
      Rank the best open issues for autonomous implementation in ${project.owner}/${project.repo}.

      Constraints:
      - choose only code-related issues
      - prefer high user value, active discussion, recent updates, and tractable scope
      - reject docs, support, translation, design-only, or vague discussion issues
      - assume issues with existing open PRs have already been removed

      Return only JSON with this schema:
      {
        "issues": [
          {
            "issueNumber": 123,
            "title": "string",
            "issueUrl": "string",
            "score": 8.5,
            "note": "string"
          }
        ]
      }

      Candidate issues:
      ${JSON.stringify(issues, null, 2)}
    `)

    const response = await promptSession(this.rootClient, this.rootSessionId, {
      agent: "build",
      model: this.modelSelection,
      parts: [{ type: "text", text: prompt }],
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            issues: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  issueNumber: { type: "number" },
                  title: { type: "string" },
                  issueUrl: { type: "string" },
                  score: { type: "number" },
                  note: { type: "string" },
                },
                required: ["issueNumber", "title", "issueUrl", "score", "note"],
              },
            },
          },
          required: ["issues"],
        },
      },
    })

    const structured = extractStructured<{ issues?: IssueCandidate[] }>(response) || safeJsonParse<{ issues?: IssueCandidate[] }>(extractText(response.parts || []))

    return Array.isArray(structured?.issues) ? structured.issues.slice(0, 6) : []
  }

  async runIssue(project: ProjectCandidate, recordEntry: IssueRecordEntry): Promise<void> {
    log("info", `Starting issue #${recordEntry.issueNumber} for ${projectKey(project.owner, project.repo)}`)
    await this.recordManager.upsert(project.owner, project.repo, {
      ...recordEntry,
      status: "running",
      assignedTo: "prer",
      lastError: "",
      note: "worker started",
    })

    try {
      const fork = await this.github.forkRepo(project.owner, project.repo)
      const forkOwner = fork.owner.login || project.owner
      const repoPath = await this.repoManager.cloneIfNeeded({
        upstreamOwner: project.owner,
        repo: project.repo,
        forkOwner,
      })
      const defaultBranch = project.defaultBranch || (await this.repoManager.defaultBranch(repoPath))
      const worktree = await this.worktreeManager.create({
        repoPath,
        owner: project.owner,
        repo: project.repo,
        issueNumber: recordEntry.issueNumber,
        title: recordEntry.title,
        defaultBranch,
      })

      await this.recordManager.upsert(project.owner, project.repo, {
        ...recordEntry,
        status: "running",
        assignedTo: "prer",
        worktreePath: worktree.worktreePath,
        branchName: worktree.branchName,
        note: `worktree=${worktree.branchName}`,
      })

      const issue = await this.github.viewIssue(project.owner, project.repo, recordEntry.issueNumber)
      let attempts = 0
      let result: PrerResult | null = null
      let validation: ValidationResult = { ok: false, note: "not started" }

      while (attempts < 2) {
        attempts += 1
        result = await this.executePrerSession({
          project,
          issue,
          worktree,
          defaultBranch,
          forkOwner,
          validationFeedback: validation.ok ? "" : validation.note,
          attempt: attempts,
        })

        validation = await this.validateResult({ project, issue, result, defaultBranch })
        if (validation.ok || result.status === "blocked") {
          break
        }
      }

      const finalStatus = validation.ok ? "done" : result?.status === "blocked" ? "blocked" : "redo"
      await this.recordManager.upsert(project.owner, project.repo, {
        ...recordEntry,
        status: finalStatus,
        assignedTo: validation.ok ? "prer" : "",
        worktreePath: worktree.worktreePath,
        prUrl: result?.prUrl || "",
        branchName: result?.branch || worktree.branchName,
        commitSha: result?.commitSha || "",
        verification: Array.isArray(result?.verification) ? result.verification : [],
        note: validation.note,
        lastError: validation.ok ? "" : validation.note,
      })

      log("info", `Finished issue #${recordEntry.issueNumber} with status ${finalStatus}`)
    } catch (error) {
      const message = error instanceof Error ? error.stack || error.message : String(error)
      await this.recordManager.upsert(project.owner, project.repo, {
        ...recordEntry,
        status: "redo",
        assignedTo: "",
        note: `worker failed; retry after ${Math.round(this.retryDelayMs / 1000)}s backoff`,
        lastError: message,
      })
      throw error
    }
  }

  async executePrerSession(params: {
    project: ProjectCandidate
    issue: GitHubIssueView
    worktree: { worktreePath: string; branchName: string }
    defaultBranch: string
    forkOwner: string
    validationFeedback: string
    attempt: number
  }): Promise<PrerResult> {
    const runtime = new OpencodeRuntime({
      opencodeBin: this.config.opencodeBin,
      cwd: params.worktree.worktreePath,
      port: randomPort(8000),
      configDir: this.config.agentConfigDir,
      hostname: "127.0.0.1",
    })

    try {
      const client = await runtime.start()
      const session = await createSession(client, `prer ${params.project.repo} #${params.issue.number} attempt ${params.attempt}`)
      const prompt = dedent(`
        You are handling a single assigned GitHub issue.

        Repository: ${params.project.owner}/${params.project.repo}
        Default branch: ${params.defaultBranch}
        Fork owner: ${params.forkOwner}
        Issue number: ${params.issue.number}
        Issue title: ${params.issue.title}
        Issue URL: ${params.issue.url}
        Current branch: ${params.worktree.branchName}
        Attempt: ${params.attempt}

        Issue body:
        ${params.issue.body || "(empty)"}

        Validator feedback from the orchestrator:
        ${params.validationFeedback || "(none)"}

        Requirements:
        - Work only in the current worktree.
        - Understand the issue and relevant code before editing.
        - Make the smallest correct code change.
        - Run the most relevant verification commands you can.
        - Commit your changes.
        - Open or update a pull request with gh.
        - Do not mention being a bot.
        - If you cannot finish, explain precisely why.

        Return ONLY valid JSON matching this schema:
        {
          "status": "done" | "blocked" | "needs_redo",
          "summary": "string",
          "prUrl": "string",
          "branch": "string",
          "commitSha": "string",
          "verification": ["string"],
          "notes": ["string"]
        }
      `)

      const response = await promptSession(client, session.id, {
        agent: "prer",
        model: this.modelSelection,
        parts: [{ type: "text", text: prompt }],
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              status: { type: "string", enum: ["done", "blocked", "needs_redo"] },
              summary: { type: "string" },
              prUrl: { type: "string" },
              branch: { type: "string" },
              commitSha: { type: "string" },
              verification: { type: "array", items: { type: "string" } },
              notes: { type: "array", items: { type: "string" } },
            },
            required: ["status", "summary", "prUrl", "branch", "commitSha", "verification", "notes"],
          },
        },
      })

      const structured = extractStructured<PrerResult>(response)
      if (structured) {
        return structured
      }

      const fallbackText = extractText(response.parts || [])
      const fallback = safeJsonParse<PrerResult>(fallbackText)
      if (!fallback) {
        throw new Error(`Unable to parse prer response: ${fallbackText}`)
      }

      return fallback
    } finally {
      await runtime.stop()
    }
  }

  async validateResult(params: {
    project: ProjectCandidate
    issue: GitHubIssueView
    result: PrerResult | null
    defaultBranch: string
  }): Promise<ValidationResult> {
    if (!params.result) {
      return { ok: false, note: `missing prer result for issue #${params.issue.number}` }
    }

    if (params.result.status === "blocked") {
      return { ok: false, note: `blocked: ${params.result.summary}` }
    }

    if (!Array.isArray(params.result.verification) || params.result.verification.length === 0) {
      return { ok: false, note: `missing verification commands for issue #${params.issue.number}` }
    }

    if (!params.result.prUrl || !/^https:\/\//.test(params.result.prUrl)) {
      return { ok: false, note: `missing pr url for issue #${params.issue.number}` }
    }

    let pr: GitHubPullRequestView
    try {
      pr = await this.github.prView(params.project.owner, params.project.repo, params.result.prUrl)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, note: `cannot inspect pr ${params.result.prUrl}: ${message}` }
    }

    const agentReview = await this.askRootAgentToValidate(params.issue, params.result, pr)
    if (agentReview && !agentReview.ok) {
      return { ok: false, note: agentReview.note }
    }

    if (pr.isDraft) {
      return { ok: false, note: `draft pr is not allowed: ${pr.url}` }
    }

    if (pr.baseRefName !== params.defaultBranch) {
      return { ok: false, note: `pr base branch ${pr.baseRefName} does not match ${params.defaultBranch}` }
    }

    if (pr.state !== "OPEN") {
      return { ok: false, note: `pr state must be OPEN, got ${pr.state}` }
    }

    return { ok: true, note: `validated pr ${pr.url}` }
  }

  async askRootAgentToValidate(
    issue: GitHubIssueView,
    result: PrerResult,
    pr: GitHubPullRequestView,
  ): Promise<ValidationResult | null> {
    if (!this.rootClient || !this.rootSessionId) {
      throw new Error("Root OpenCode runtime is not ready")
    }

    const prompt = dedent(`
      Validate whether this PR result is legitimate for the assigned issue.

      Criteria:
      - PR exists and is plausibly relevant to the issue
      - verification list is meaningful
      - summary does not obviously conflict with the issue
      - if invalid, explain the most important reason briefly

      Return only JSON with this schema:
      {
        "ok": true,
        "note": "string"
      }

      Issue:
      ${JSON.stringify({ number: issue.number, title: issue.title, body: issue.body, url: issue.url }, null, 2)}

      Result:
      ${JSON.stringify(result, null, 2)}

      PR:
      ${JSON.stringify(pr, null, 2)}
    `)

    const response = await promptSession(this.rootClient, this.rootSessionId, {
      agent: "build",
      model: this.modelSelection,
      parts: [{ type: "text", text: prompt }],
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean" },
            note: { type: "string" },
          },
          required: ["ok", "note"],
        },
      },
    })

    return extractStructured<ValidationResult>(response) || safeJsonParse<ValidationResult>(extractText(response.parts || []))
  }

  async shutdown(): Promise<void> {
    if (this.activeWorkers.size > 0) {
      await Promise.allSettled([...this.activeWorkers.values()])
    }

    if (this.rootRuntime) {
      await this.rootRuntime.stop()
      this.rootRuntime = null
      this.rootClient = null
      this.rootSessionId = null
    }
  }
}
