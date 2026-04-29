import { loadConfig } from "./config.js"
import { Orchestrator } from "./orchestrator.js"

const config = loadConfig()
const orchestrator = new Orchestrator(config)

async function shutdown(signal: string): Promise<void> {
  console.log(`[${new Date().toISOString()}] received ${signal}, shutting down`)
  await orchestrator.shutdown()
  process.exit(0)
}

process.on("SIGINT", () => {
  void shutdown("SIGINT")
})

process.on("SIGTERM", () => {
  void shutdown("SIGTERM")
})

await orchestrator.run()
