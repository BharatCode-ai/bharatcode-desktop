import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createMobileAccess } from "../src/desktop-access.mjs"
import QRCode from "qrcode"
import { PNG } from "pngjs"

test("pairing QR preserves a four-module clear border for physical scanners", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bc-access-qr-margin-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const access = await createMobileAccess({
    userDataPath: directory,
    getConnection: () => ({
      url: "http://127.0.0.1:4096",
      password: "private",
    }),
    tunnelFactory: async () => ({
      origin: "https://pc.tunnel.bharatcode.ai",
      events: (async function* () {})(),
      close: async () => {},
    }),
  })
  t.after(() => access.close())
  await access.action({ type: "pair" })
  const state = access.snapshot()
  const image = PNG.sync.read(Buffer.from(state.qrImage.split(",")[1], "base64"))
  let left = image.width,
    top = image.height,
    right = -1,
    bottom = -1
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const offset = (y * image.width + x) * 4
      if (image.data[offset] > 127 || image.data[offset + 3] === 0) continue
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
  }
  assert.ok(right > left, "QR must contain a visible symbol")
  const modules = QRCode.create(state.pairing, { errorCorrectionLevel: "M" }).modules.size
  const modulePixels = Math.floor(Math.min(right - left + 1, bottom - top + 1) / modules)
  const clearBorder = Math.min(left, top, image.width - 1 - right, image.height - 1 - bottom)
  assert.ok(modulePixels > 0)
  assert.ok(
    clearBorder >= modulePixels * 4,
    `clear border ${clearBorder}px is smaller than four ${modulePixels}px modules`,
  )
})

test("reset during restoration cannot start a new connection after cancellation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bc-access-restore-cancel-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, "mobile-access"))
  await writeFile(join(directory, "mobile-access", "enabled.json"), '{"enabled":true}')
  let connections = 0
  const access = await createMobileAccess({
    userDataPath: directory,
    getConnection: () => {
      connections++
      throw new Error("cancelled restore reached the sidecar")
    },
    removeTunnel: async () => {},
  })
  t.after(() => access.close())
  const restoring = access.restore()
  await Promise.resolve()
  const resetting = access.action({ type: "reset" })
  await restoring
  await resetting
  assert.equal(connections, 0)
  assert.equal(access.snapshot().enabled, false)
})

test("malformed optional mobile state cannot reject Desktop initialization or overwrite the registry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bc-access-corrupt-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, "mobile-access"))
  const path = join(directory, "mobile-access", "devices.json")
  const damaged = '{"version":1,"desktopID":'
  await writeFile(path, damaged)
  const access = await createMobileAccess({
    userDataPath: directory,
    getConnection: () => undefined,
  })
  await access.restore()
  assert.equal(access.snapshot().enabled, false)
  assert.equal(access.snapshot().status, "error")
  assert.equal(access.snapshot().errorKey, "mobile.error.storage")
  await assert.rejects(access.action({ type: "pair" }))
  await access.close()
  assert.equal(await readFile(path, "utf8"), damaged)
})

test("unavailable optional mobile directory does not reject initialization or close", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bc-access-unavailable-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, "mobile-access"), "keep this file")
  const access = await createMobileAccess({
    userDataPath: directory,
    getConnection: () => undefined,
  })
  await access.restore()
  assert.equal(access.snapshot().status, "error")
  assert.equal(access.snapshot().errorKey, "mobile.error.storage")
  await access.close()
  assert.equal(await readFile(join(directory, "mobile-access"), "utf8"), "keep this file")
})

test("reset cancels pending issuance before joining the action queue", { timeout: 3000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bc-access-reset-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let begin
  const ready = new Promise((resolve) => {
    begin = resolve
  })
  let aborted = false,
    removed = false
  const access = await createMobileAccess({
    userDataPath: directory,
    getConnection: () => ({
      url: "http://127.0.0.1:4096",
      password: "private",
    }),
    tunnelFactory: async ({ signal }) => {
      begin()
      await new Promise((_, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true
            reject(new Error("cancelled"))
          },
          { once: true },
        ),
      )
    },
    removeTunnel: async () => {
      removed = true
    },
  })
  t.after(() => access.close())
  const pairing = access.action({ type: "pair" }).catch(() => {})
  await ready
  const reset = access.action({ type: "reset" })
  try {
    await Promise.race([
      reset,
      new Promise((_, reject) => setTimeout(() => reject(new Error("reset did not cancel issuance")), 500)),
    ])
    assert.equal(aborted, true)
    assert.equal(removed, true)
    assert.equal(access.snapshot().enabled, false)
    assert.equal(access.snapshot().status, "off")
  } finally {
    await access.action({ type: "disable" })
    await pairing
    await reset
  }
})

test("reset cancels a queued pair before it starts provisioning", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bc-access-queued-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const access = await createMobileAccess({
    userDataPath: directory,
    getConnection: () => {
      throw new Error("cancelled pairing must not reach the sidecar")
    },
    removeTunnel: async () => {},
  })
  t.after(() => access.close())
  const pair = access.action({ type: "pair" })
  const reset = access.action({ type: "reset" })
  await pair
  await reset
  assert.equal(access.snapshot().status, "off")
})

test("failure to persist enabled state closes the new tunnel and leaves access disabled", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bc-access-write-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, "mobile-access", "enabled.json"), {
    recursive: true,
  })
  let closed = false
  const access = await createMobileAccess({
    userDataPath: directory,
    getConnection: () => ({
      url: "http://127.0.0.1:4096",
      password: "private",
    }),
    tunnelFactory: async () => ({
      origin: "https://pc.tunnel.bharatcode.ai",
      events: (async function* () {})(),
      close: async () => {
        closed = true
      },
    }),
  })
  t.after(() => access.close())
  await assert.rejects(access.action({ type: "pair" }))
  assert.equal(access.snapshot().enabled, false)
  assert.equal(closed, true)
})

test("explicit reset preserves a damaged registry backup and allows fresh pairing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bc-access-repair-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, "mobile-access")
  await mkdir(root)
  const damaged = '{"version":1,"desktopID":'
  await writeFile(join(root, "devices.json"), damaged)
  const access = await createMobileAccess({
    userDataPath: directory,
    getConnection: () => ({
      url: "http://127.0.0.1:4096",
      password: "private",
    }),
    removeTunnel: async () => {},
    tunnelFactory: async () => ({
      origin: "https://pc.tunnel.bharatcode.ai",
      events: (async function* () {})(),
      close: async () => {},
    }),
  })
  t.after(() => access.close())
  await access.restore()
  await access.action({ type: "reset" })
  const backups = (await readdir(root)).filter((name) => name.startsWith("devices.json.corrupt-"))
  assert.equal(backups.length, 1)
  assert.equal(await readFile(join(root, backups[0]), "utf8"), damaged)
  await access.action({ type: "pair" })
  assert.equal(access.snapshot().status, "connected")
  assert.deepEqual(access.snapshot().devices, [])
})

test("Desktop starts no tunnel until enabled, and disabling closes both resources", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bc-access-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let connects = 0,
    closes = 0
  const access = await createMobileAccess({
    userDataPath: directory,
    getConnection: () => ({
      url: "http://127.0.0.1:4096",
      username: "opencode",
      password: "private",
    }),
    tunnelFactory: async () => {
      connects++
      return {
        origin: "https://unit.tunnel.bharatcode.ai",
        close: async () => {
          closes++
        },
        events: (async function* () {})(),
      }
    },
  })
  t.after(() => access.close())
  await access.restore()
  assert.equal(access.snapshot().errorKey, undefined)
  assert.equal(connects, 0)
  await access.action({ type: "pair" })
  assert.equal(connects, 1)
  assert.ok(access.snapshot().qrImage.startsWith("data:image/png;base64,"))
  assert.equal(new URL(access.snapshot().pairing).hostname, "pair")
  await access.action({ type: "disable" })
  assert.equal(closes, 1)
  assert.equal(access.snapshot().enabled, false)
  assert.equal(access.snapshot().pairing, undefined)
  await assert.rejects(access.action({ type: "approve", id: "unknown" }))
})

test("Desktop refuses a remote or unprotected sidecar without creating a tunnel", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bc-access-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const access = await createMobileAccess({
    userDataPath: directory,
    getConnection: () => ({ url: "https://other.example", password: "" }),
    tunnelFactory: () => {
      throw new Error("must not connect")
    },
  })
  t.after(() => access.close())
  await assert.rejects(access.action({ type: "pair" }))
  assert.equal(access.snapshot().enabled, false)
})

test(
  "provisioning reports progress while status stays readable and disconnect cancels startup",
  { timeout: 2000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "bc-access-"))
    t.after(() => rm(directory, { recursive: true, force: true }))
    let began
    const ready = new Promise((resolve) => (began = resolve))
    const access = await createMobileAccess({
      userDataPath: directory,
      getConnection: () => ({
        url: "http://127.0.0.1:4096",
        password: "private",
      }),
      tunnelFactory: async ({ signal, onProgress }) => {
        onProgress("waiting-certificate")
        began()
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
        )
      },
    })
    t.after(() => access.close())
    const pairing = access.action({ type: "pair" }).catch(() => {})
    await ready
    const snapshot = await access.action({ type: "state" })
    assert.equal(snapshot.status, "provisioning")
    assert.equal(snapshot.progress, "waiting-certificate")
    await access.action({ type: "disable" })
    await pairing
    assert.equal(access.snapshot().status, "off")
  },
)

test("Desktop emits credential-free links, restores enabled identity and clears revoked phones on reset", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bc-access-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let connects = 0,
    removed = 0
  const options = {
    userDataPath: directory,
    getConnection: () => ({
      url: "http://127.0.0.1:4096",
      password: "private",
    }),
    tunnelFactory: async () => {
      connects++
      return {
        origin: "https://pc.tunnel.bharatcode.ai",
        events: (async function* () {})(),
        close: async () => {},
      }
    },
    removeTunnel: async () => {
      removed++
    },
  }
  const first = await createMobileAccess(options)
  await first.action({ type: "pair" })
  const link = new URL(first.snapshot().pairing)
  assert.equal(link.protocol, "bharatcode:")
  assert.deepEqual([...link.searchParams.keys()].sort(), ["desktopID", "origin"])
  assert.equal(first.snapshot().status, "connected")
  await first.close()
  const second = await createMobileAccess(options)
  t.after(() => second.close())
  await second.restore()
  assert.equal(connects, 2)
  assert.equal(second.snapshot().enabled, true)
  await second.action({ type: "reset" })
  assert.equal(removed, 1)
  assert.deepEqual(second.snapshot().devices, [])
  assert.equal(second.snapshot().enabled, false)
})

test("Desktop status reflects a phone unpairing itself immediately", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bc-access-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let target
  const access = await createMobileAccess({
    userDataPath: directory,
    getConnection: () => ({
      url: "http://127.0.0.1:4096",
      password: "private",
    }),
    tunnelFactory: async (options) => {
      target = options.target
      return {
        origin: "https://pc.tunnel.bharatcode.ai",
        events: (async function* () {})(),
        close: async () => {},
      }
    },
  })
  t.after(() => access.close())
  await access.action({ type: "pair" })
  const link = new URL(access.snapshot().pairing)
  const post = (path, body) =>
    fetch(target + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  const claim = await (
    await post("/mobile/v1/claim", {
      desktopID: link.searchParams.get("desktopID"),
      deviceName: "Phone",
    })
  ).json()
  await access.action({ type: "approve", id: claim.claimID })
  const paired = await (await post("/mobile/v1/claim/status", claim)).json()
  assert.equal((await access.action({ type: "state" })).devices.length, 1)
  assert.equal(
    (
      await fetch(target + "/mobile/v1/device", {
        method: "DELETE",
        headers: { authorization: "Bearer " + paired.token },
      })
    ).status,
    200,
  )
  assert.equal((await access.action({ type: "state" })).devices.length, 0)
})

test("self-hosted identities use a service-specific store, never the old upstream token", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bc-access-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let actual
  const access = await createMobileAccess({
    userDataPath: directory,
    getConnection: () => ({
      url: "http://127.0.0.1:4096",
      password: "private",
    }),
    tunnelFactory: async ({ storePath }) => {
      actual = storePath
      return {
        origin: "https://pc.tunnel.bharatcode.ai",
        events: (async function* () {})(),
        close: async () => {},
      }
    },
  })
  t.after(() => access.close())
  await access.action({ type: "pair" })
  assert.equal(actual, join(directory, "mobile-access", "tunnel-bharatcode-ai"))
})
