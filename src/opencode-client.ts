import { spawn } from "node:child_process"
import { once } from "node:events"
import {
  createOpencodeClient,
  type OpencodeClient,
  type OutputFormat,
} from "@opencode-ai/sdk/v2/client"
import type { OpenCodePromptResult, OpenCodeSession } from "./types.js"
import { sleep } from "./utils.js"

interface RuntimeOptions {
  opencodeBin: string
  cwd: string
  port: number
  hostname?: string
  configDir: string
  env?: NodeJS.ProcessEnv
}

interface ServerProcess {
  child: ReturnType<typeof spawn>
  getLogs: () => { stdout: string; stderr: string }
}

type SessionPromptParameters = Parameters<OpencodeClient["session"]["prompt"]>[0]
type PromptBody = Omit<SessionPromptParameters, "sessionID" | "directory" | "workspace"> & {
  parts: Array<{ type: "text"; text: string }>
  format?: OutputFormat
}

interface SessionMessageEnvelope {
  info?: OpenCodePromptResult["info"]
  parts?: OpenCodePromptResult["parts"]
}

function startServerProcess({ opencodeBin, cwd, port, hostname = "127.0.0.1", configDir, env = {} }: RuntimeOptions): ServerProcess {
  const child = spawn(opencodeBin, ["serve", "--hostname", hostname, "--port", String(port)], {
    cwd,
    env: {
      ...process.env,
      ...env,
      OPENCODE_CONFIG_DIR: configDir,
    },
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

  return {
    child,
    getLogs() {
      return { stdout, stderr }
    },
  }
}

async function waitForHealth(port: number, attempts = 40): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok) return
      const text = await res.text().catch(() => "")
      if (text.includes("opencode") || text.includes("html") || text.length > 0) return
    } catch {}
    await sleep(500)
  }

  throw new Error("OpenCode server did not become healthy in time")
}

function extractMessages(raw: unknown): SessionMessageEnvelope[] {
  const value = raw as { data?: unknown; messages?: unknown }
  const data = value?.data ?? raw

  if (Array.isArray(data)) {
    return data as SessionMessageEnvelope[]
  }

  if (data && typeof data === "object" && Array.isArray((data as { messages?: unknown[] }).messages)) {
    return (data as { messages: SessionMessageEnvelope[] }).messages
  }

  return []
}

function toPromptResult(message: SessionMessageEnvelope): OpenCodePromptResult {
  return {
    info: message.info,
    parts: Array.isArray(message.parts) ? message.parts : [],
  }
}

export class OpencodeRuntime {
  private server: ServerProcess | null = null
  private client: OpencodeClient | null = null

  constructor(private readonly options: RuntimeOptions) {}

  async start(): Promise<OpencodeClient> {
    const server = startServerProcess(this.options)
    const client = createOpencodeClient({
      baseUrl: `http://${this.options.hostname || "127.0.0.1"}:${this.options.port}`,
      throwOnError: true,
    })

    try {
      await waitForHealth(this.options.port)
    } catch (error) {
      server.child.kill("SIGTERM")
      const logs = server.getLogs()
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${message}\nSTDERR:\n${logs.stderr}\nSTDOUT:\n${logs.stdout}`)
    }

    this.server = server
    this.client = client
    return client
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return
    }

    this.server.child.kill("SIGTERM")
    await once(this.server.child, "close").catch(() => {})
    this.server = null
    this.client = null
  }
}

export async function createSession(client: OpencodeClient, title: string): Promise<OpenCodeSession> {
  const session = await client.session.create({ title })
  return session.data as OpenCodeSession
}

export async function promptSession(
  client: OpencodeClient,
  sessionId: string,
  body: PromptBody,
): Promise<OpenCodePromptResult> {
  const beforeResponse = await client.session.messages({
    sessionID: sessionId,
    limit: 50,
  })
  const knownMessageIds = new Set(
    extractMessages(beforeResponse)
      .map((message) => message.info?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  )
  const startedAt = Date.now()

  const promptResponse = await client.session.prompt({
    sessionID: sessionId,
    ...body,
  })

  const direct = (promptResponse as { data?: unknown }).data ?? promptResponse
  if (direct && typeof direct === "object") {
    const directResult = toPromptResult(direct as SessionMessageEnvelope)
    if (directResult.info?.role === "assistant") {
      return directResult
    }
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(1000)

    const messagesResponse = await client.session.messages({
      sessionID: sessionId,
      limit: 10,
    })

    const assistantMessages = extractMessages(messagesResponse)
      .filter((message) => message.info?.role === "assistant")
      .filter((message) => {
        const id = message.info?.id
        const createdAt = message.info?.time?.created ?? 0
        return (id ? !knownMessageIds.has(id) : true) || createdAt >= startedAt
      })
      .sort((left, right) => (right.info?.time?.created ?? 0) - (left.info?.time?.created ?? 0))

    for (const message of assistantMessages) {
      const hasStructured = message.info?.structured !== undefined || message.info?.structured_output !== undefined
      const hasParts = Array.isArray(message.parts) && message.parts.length > 0
      const completed = Boolean(message.info?.time?.completed)
      if (hasStructured || hasParts || completed) {
        return toPromptResult(message)
      }
    }
  }

  throw new Error(`Timeout waiting for assistant message`)
}

export async function listAgents(client: OpencodeClient): Promise<unknown> {
  const response = await client.app.agents()
  return response.data
}
