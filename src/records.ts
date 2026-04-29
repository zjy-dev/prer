import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { IssueRecordEntry, RecordProjectRef } from "./types.js"
import { formatIssueRecord, nowIso, recordFileName } from "./utils.js"

export class RecordManager {
  constructor(private readonly options: { recordsDir: string }) {}

  async ensureBaseDirs(): Promise<void> {
    await mkdir(this.options.recordsDir, { recursive: true })
  }

  filePath(owner: string, repo: string): string {
    return path.join(this.options.recordsDir, recordFileName(owner, repo))
  }

  async listProjects(): Promise<RecordProjectRef[]> {
    const entries = await readdir(this.options.recordsDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return []
      }

      throw error
    })

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name.includes("__"))
      .map((entry) => {
        const baseName = entry.name.slice(0, -3)
        const [owner, repo] = baseName.split("__")
        return { owner, repo, filePath: path.join(this.options.recordsDir, entry.name) }
      })
  }

  async read(owner: string, repo: string): Promise<IssueRecordEntry[]> {
    const filePath = this.filePath(owner, repo)

    try {
      const content = await readFile(filePath, "utf8")
      return content
        .split("\n")
        .filter((line) => line.startsWith("- {"))
        .map((line) => this.parseLine(line))
        .filter((entry): entry is IssueRecordEntry => entry !== null)
    } catch (error) {
      const typedError = error as NodeJS.ErrnoException
      if (typedError.code === "ENOENT") {
        return []
      }

      throw typedError
    }
  }

  parseLine(line: string): IssueRecordEntry | null {
    const raw = line.slice(2)
    let parsed: IssueRecordEntry

    try {
      parsed = JSON.parse(raw) as IssueRecordEntry
    } catch {
      return null
    }

    return {
      status: parsed.status,
      issueNumber: parsed.issueNumber,
      title: parsed.title,
      issueUrl: parsed.issueUrl,
      score: parsed.score,
      assignedTo: parsed.assignedTo || "",
      worktreePath: parsed.worktreePath || "",
      prUrl: parsed.prUrl || "",
      updatedAt: parsed.updatedAt || nowIso(),
      note: parsed.note || "",
      repoOwner: parsed.repoOwner || "",
      repoName: parsed.repoName || "",
      branchName: parsed.branchName || "",
      commitSha: parsed.commitSha || "",
      verification: Array.isArray(parsed.verification) ? parsed.verification : [],
      lastError: parsed.lastError || "",
    }
  }

  async upsert(owner: string, repo: string, entry: IssueRecordEntry): Promise<void> {
    const records = await this.read(owner, repo)
    const filtered = records.filter((record) => record.issueNumber !== entry.issueNumber)
    filtered.push({
      ...entry,
      repoOwner: owner,
      repoName: repo,
      branchName: entry.branchName || "",
      commitSha: entry.commitSha || "",
      verification: Array.isArray(entry.verification) ? entry.verification : [],
      lastError: entry.lastError || "",
      updatedAt: nowIso(),
    })
    filtered.sort((left, right) => left.issueNumber - right.issueNumber)

    const lines = filtered.map((record) => formatIssueRecord(record)).join("\n")
    await writeFile(this.filePath(owner, repo), lines ? `${lines}\n` : "", "utf8")
  }
}
