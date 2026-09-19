import { Global } from "@opencode-ai/core/global"
import type { Argv } from "yargs"

import { activateMigration, prepareMigration, startFresh } from "@/migration/cutover"
import { fingerprintMigrationSource } from "@/migration/capture"
import { readMigrationJournal } from "@/migration/journal"
import { discoverMigrationSources, type MigrationSource } from "@/migration/source"
import { cmd } from "./cmd"

// The import runs only when the user asks for it. It used to sit on the desktop
// startup path, where every launch spawned this CLI, opened the database and
// checked a schema marker before the window would paint -- work that is wasted
// on any launch that is not a first run.
export function destination() {
  return {
    data: Global.Path.data,
    config: Global.Path.config,
    state: Global.Path.recovery,
    database: Global.Path.database,
    storage: Global.Path.storage,
  }
}

export function discover() {
  return discoverMigrationSources({
    platform: process.platform as "linux" | "darwin" | "win32",
    home: Global.Path.home,
    env: process.env,
    destinationRoots: [Global.Path.data, Global.Path.config, Global.Path.storage],
  })
}

/**
 * Cheap enough for a startup notice: reads one small JSON file, with no database
 * open and no subprocess. Returns the operation to resume, if any.
 */
export async function interruptedImport() {
  const journal = await readMigrationJournal(Global.Path.recovery)
  return journal && journal.phase !== "complete" ? journal : undefined
}

function describe(source: MigrationSource) {
  return `  ${source.id}  ${source.label}  (${source.kind})`
}

async function run(choice: { id: string; contentFingerprint: string } | undefined) {
  const sources = await discover()
  const prepared = await prepareMigration({ sources, choice, destination: destination() })
  if (prepared.type === "start-fresh") {
    console.log(`Nothing to import (${prepared.reason}). Starting fresh.`)
    await startFresh({ destination: destination(), reason: prepared.reason, confirmed: true })
    return
  }
  if (prepared.type === "choose-source") {
    console.log("More than one installation can be imported. Re-run with --source <id>:")
    for (const source of sources) console.log(describe(source))
    return
  }
  if (prepared.type === "retry") {
    console.log(`An earlier import was interrupted. Resuming ${prepared.operationID}.`)
  }
  const result = await activateMigration({ operationID: prepared.operationID, destination: destination() })
  console.log(`Imported ${result.sourceID}.`)
}

const MigrateStatusCommand = cmd({
  command: "$0",
  describe: "list installations that can be imported",
  handler: async () => {
    const interrupted = await interruptedImport()
    if (interrupted) {
      console.log(`An earlier import was interrupted at "${interrupted.phase}".`)
      console.log(`Resume it with: bharatcode migrate run --resume`)
      return
    }
    const sources = await discover()
    if (sources.length === 0) {
      console.log("No other BharatCode or OpenCode installation was found.")
      return
    }
    console.log("Found these installations. Import one with: bharatcode migrate run --source <id>")
    for (const source of sources) console.log(describe(source))
  },
})

const MigrateRunCommand = cmd({
  command: "run",
  describe: "import sessions and configuration from another installation",
  builder: (yargs: Argv) =>
    yargs
      .option("source", { type: "string", describe: "id of the installation to import, from `bharatcode migrate`" })
      .option("resume", { type: "boolean", default: false, describe: "resume an interrupted import" }),
  handler: async (args: { source?: string; resume: boolean }) => {
    if (args.resume) return run(undefined)
    if (!args.source) {
      console.log("Pass --source <id>, or run `bharatcode migrate` to list what is available.")
      return
    }
    const sources = await discover()
    const source = sources.find((item) => item.id === args.source)
    if (!source) {
      console.log(`No installation with id "${args.source}". Run \`bharatcode migrate\` to list them.`)
      return
    }
    await run({ id: source.id, contentFingerprint: await fingerprintMigrationSource(source) })
  },
})

export const MigrateCommand = cmd({
  command: "migrate",
  describe: "import data from another BharatCode or OpenCode installation",
  builder: (yargs: Argv) => yargs.command(MigrateStatusCommand).command(MigrateRunCommand),
  handler: () => {},
})
