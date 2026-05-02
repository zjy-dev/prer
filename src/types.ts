export type RecordStatus = "queued" | "running" | "done" | "blocked" | "redo"

export interface PrerConfig {
  rootDir: string
  reposDir: string
  worktreesDir: string
  recordsDir: string
  tempDir: string
  agentConfigDir: string
  pollIntervalMs: number
  concurrency: number
  opencodeBin: string
  model?: string
  providerId?: string
  modelId?: string
  logLevel: string
  dryRun: boolean
  githubSearchQuery: string
}

export interface ModelSelection {
  providerID: string
  modelID: string
}

export interface CommandResult {
  stdout: string
  stderr: string
}

export interface CommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface CommandFailure extends Error {
  code?: number | null
  stdout?: string
  stderr?: string
}

export interface GitHubOwner {
  login: string
}

export interface GitHubLanguage {
  name: string
}

export interface GitHubLabel {
  name: string
}

export interface GitHubRepositorySearchItem {
  name: string
  owner: GitHubOwner
  description: string | null
  sshUrl?: string
  isArchived: boolean
  isFork: boolean
  stargazersCount: number
  updatedAt: string
  url: string
  defaultBranch: string
  language?: string | null
}

export type GitHubIssueComments = number | Array<Record<string, unknown>>

export interface GitHubIssueSummary {
  number: number
  title: string
  body?: string | null
  labels: GitHubLabel[]
  comments: GitHubIssueComments
  assignees?: Array<Record<string, unknown>>
  updatedAt: string
  url: string
  author?: GitHubOwner | null
}

export interface GitHubIssueView extends GitHubIssueSummary {
  state?: string
  milestone?: Record<string, unknown> | null
  projectItems?: Array<Record<string, unknown>>
}

export interface GitHubPullRequestSearchResult {
  number: number
  title: string
  state: string
  url: string
  updatedAt: string
  headRepositoryOwner?: GitHubOwner | null
  headRefName?: string
  baseRefName?: string
  isDraft?: boolean
}

export interface GitHubPullRequestView {
  url: string
  state: string
  isDraft: boolean
  title: string
  body?: string | null
  headRefName: string
  headRepositoryOwner?: GitHubOwner | null
  baseRefName: string
  mergeable?: string | null
  number: number
}

export interface RecordProjectRef {
  owner: string
  repo: string
  filePath: string
}

export interface IssueRecordEntry {
  repoOwner?: string
  repoName?: string
  status: RecordStatus
  issueNumber: number
  title: string
  issueUrl: string
  score: number
  assignedTo: string
  worktreePath: string
  prUrl: string
  updatedAt?: string
  note: string
  branchName: string
  commitSha: string
  verification: string[]
  lastError: string
}

export interface ProjectCandidate {
  owner: string
  repo: string
  reason: string
  stars: number
  url: string
  defaultBranch: string
  updatedAt?: string
  description?: string
  language?: string
  name?: string
}

export interface IssueCandidate {
  issueNumber: number
  title: string
  issueUrl: string
  score: number
  note: string
}

export interface DiscoveredIssueInput {
  number: number
  title: string
  url: string
  body: string
  updatedAt: string
  labels: string[]
  comments: number
}

export interface ValidationResult {
  ok: boolean
  note: string
}

export interface PrerResult {
  status: "done" | "blocked" | "needs_redo"
  summary: string
  prUrl: string
  branch: string
  commitSha: string
  verification: string[]
  notes: string[]
}

export interface WorkerQueueItem {
  owner: string
  repo: string
  project: ProjectCandidate
  entry: IssueRecordEntry
}

export interface OpenCodeSession {
  id: string
}

export interface OpenCodeTextPart {
  type: string
  text?: string
}

export interface OpenCodePromptInfo {
  id?: string
  role?: string
  parentID?: string
  time?: {
    created?: number
    completed?: number
  }
  structured?: unknown
  structured_output?: unknown
}

export interface OpenCodePromptResult {
  info?: OpenCodePromptInfo
  parts?: OpenCodeTextPart[]
}
