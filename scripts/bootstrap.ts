import { mkdir } from "node:fs/promises"
import path from "node:path"

const root = process.cwd()
const directories = ["repos", "worktrees", "records", ".tmp"]

await Promise.all(directories.map((directory) => mkdir(path.join(root, directory), { recursive: true })))

console.log(`Prepared directories: ${directories.join(", ")}`)
