import { setTimeout as sleepTimeout } from "node:timers/promises"
import type { IssueRecordEntry } from "./types.js"

export function sleep(ms: number): Promise<void> {
  return sleepTimeout(ms).then(() => undefined)
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

export function recordFileName(owner: string, repo: string): string {
  return `${owner}__${repo}.md`
}

export function projectKey(owner: string, repo: string): string {
  return `${owner}/${repo}`
}

export function worktreeName(owner: string, repo: string, issueNumber: number): string {
  return `${owner}__${repo}-issue-${issueNumber}`
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function safeJsonParse<T>(value: string, fallback: T | null = null): T | null {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function dedent(text: string): string {
  const lines = text.replace(/^\n/, "").split("\n")
  const nonEmpty = lines.filter((line) => line.trim().length > 0)
  const indent = nonEmpty.reduce((current, line) => {
    const match = line.match(/^\s*/)
    const size = match ? match[0].length : 0
    return Math.min(current, size)
  }, Number.POSITIVE_INFINITY)

  if (!Number.isFinite(indent)) {
    return text.trim()
  }

  return lines.map((line) => line.slice(indent)).join("\n").trim()
}

export function formatIssueRecord(entry: IssueRecordEntry): string {
  return `- ${JSON.stringify(entry)}`
}

export function countComments(value: number | Array<Record<string, unknown>>): number {
  if (Array.isArray(value)) {
    return value.length
  }

  return typeof value === "number" ? value : 0
}

export function last<T>(array: T[]): T | undefined {
  return array[array.length - 1]
}
