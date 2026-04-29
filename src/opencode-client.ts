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

async function waitForHealth(client: OpencodeClient, attempts = 40): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    try {
      await client.global.health()
      return
    } catch {
      await sleep(500)
    }
  }

  throw new Error("OpenCode server did not become healthy in time")
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
      await waitForHealth(client)
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
  const response = await client.session.prompt({
    sessionID: sessionId,
    ...body,
  })

  return response.data as OpenCodePromptResult
}

export async function listAgents(client: OpencodeClient): Promise<unknown> {
  const response = await client.app.agents()
  return response.data
}
