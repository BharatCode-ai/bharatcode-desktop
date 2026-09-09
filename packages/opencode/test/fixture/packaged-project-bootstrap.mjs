import assert from "node:assert/strict"
import net from "node:net"
import path from "node:path"
import { pathToFileURL } from "node:url"

const [root, sidecar] = process.argv.slice(2)
assert(path.basename(root).startsWith("bc-project-packaged-"))
assert(process.env.USERPROFILE === root && process.env.HOME === root)
assert(sidecar.includes(`${path.sep}app.asar${path.sep}out${path.sep}main${path.sep}`))
const probe = net.createServer()
await new Promise((resolve, reject) => {
  probe.once("error", reject)
  probe.listen(0, "127.0.0.1", resolve)
})
const port = probe.address().port
await new Promise((resolve) => probe.close(resolve))
const base = `http://127.0.0.1:${port}`
const original = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
  if (url.origin !== base) throw new Error("Synthetic test rejected non-loopback request")
  return original(input, init)
}
const timeout = setTimeout(() => {
  console.error("PACKAGED_PROJECT_TIMEOUT")
  process.exit(1)
}, 60_000)
let dispatch
let complete = false
async function verify() {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${base}/session?directory=${encodeURIComponent(root)}`, {
      headers: { authorization: `Basic ${Buffer.from("bharatcode:synthetic-project-password").toString("base64")}` },
    })
    assert.equal(response.status, 200, "Packaged project/session bootstrap must succeed")
    assert(Array.isArray(await response.json()))
  }
  complete = true
  dispatch({ data: { type: "stop" } })
}
process.parentPort = {
  on(event, listener) {
    assert.equal(event, "message")
    dispatch = listener
  },
  postMessage(message) {
    if (message.type === "ready")
      verify().catch((error) => {
        // Only our fixed assertion text/status, never a response/log payload.
        console.error("PACKAGED_PROJECT_FAILED", error.actual ?? "unknown")
        process.exit(1)
      })
    if (message.type === "error") {
      console.error("PACKAGED_PROJECT_SIDECAR_FAILED")
      process.exit(1)
    }
    if (message.type === "stopped") {
      assert(complete)
      clearTimeout(timeout)
      console.log("PACKAGED_PROJECT_PASS")
    }
  },
}
await import(pathToFileURL(sidecar).href)
dispatch({
  data: {
    type: "start",
    hostname: "127.0.0.1",
    port,
    userDataPath: path.join(root, "userData"),
    needsMigration: false,
  },
})
