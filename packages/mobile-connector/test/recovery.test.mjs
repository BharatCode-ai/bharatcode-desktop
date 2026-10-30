import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMobileAccess } from "../src/desktop-access.mjs"

test("corrupt journal recovery pairs a phone and safely handles real HTTP prompts through restart", async t => {
  const directory = await mkdtemp(join(tmpdir(), "bc-recovery-http-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, "mobile-access")
  await mkdir(root)
  await writeFile(join(root, "admissions.json"), '{"admissions":')
  let fresh, forwarded = 0, target
  const messages = new Map()
  const sidecar = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Basic " + Buffer.from("opencode:private").toString("base64"))
    res.setHeader("content-type", "application/json")
    const path = new URL(req.url, "http://localhost").pathname
    if (path === "/api/session" && req.method === "POST") {
      let raw = ""
      for await (const chunk of req) raw += chunk
      fresh = JSON.parse(raw).id
      res.end(JSON.stringify({ data: { id: fresh } }))
      return
    }
    if (path === "/session/ses_old" || path === "/session/" + fresh) {
      res.end(JSON.stringify({ directory: "/fixture", time: { created: Date.now() + 3_600_000 } }))
      return
    }
    if (path.endsWith("/prompt_async")) {
      let raw = ""
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      forwarded++
      messages.set(path.split("/")[2] + "." + body.messageID, body.parts)
      res.writeHead(204).end()
      return
    }
    const match = /^\/session\/(ses_\w+)\/message\/(msg_\w+)$/.exec(path)
    const parts = match && messages.get(match[1] + "." + match[2])
    if (parts) res.end(JSON.stringify({ info: { id: match[2], role: "user" }, parts }))
    else res.writeHead(404).end("{}")
  })
  sidecar.listen(0, "127.0.0.1")
  await once(sidecar, "listening")
  t.after(() => { sidecar.closeAllConnections(); return new Promise(resolve => sidecar.close(resolve)) })
  const options = {
    userDataPath: directory,
    getConnection: () => ({ url: `http://127.0.0.1:${sidecar.address().port}`, password: "private" }),
    removeTunnel: async () => {},
    tunnelFactory: async options => {
      target = options.target
      return { origin: "https://pc.tunnel.bharatcode.ai", events: (async function* () {})(), close: async () => {} }
    },
  }
  let access = await createMobileAccess(options)
  t.after(() => access.close())
  await assert.rejects(access.action({ type: "pair" }))
  await access.action({ type: "reset" })
  const pair = async () => {
    await access.action({ type: "pair" })
    const link = new URL(access.snapshot().pairing)
    const post = (path, body) => fetch(target + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    const claim = await (await post("/mobile/v1/claim", { desktopID: link.searchParams.get("desktopID"), deviceName: "Fixture phone" })).json()
    await access.action({ type: "approve", id: claim.claimID })
    return (await (await post("/mobile/v1/claim/status", claim)).json()).token
  }
  let token = await pair()
  const send = (session, text = "Only once") => fetch(target + `/api/session/${session}/prompt`, {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ id: "msg_one", prompt: { text } }),
  })
  const blocked = await send("ses_old")
  assert.equal(blocked.status, 409)
  assert.match(await blocked.text(), /recovered.*new conversation/)
  assert.equal(forwarded, 0)
  const created = await fetch(target + "/api/session", {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ location: { directory: "/fixture" } }),
  })
  assert.equal(created.status, 200)
  fresh = (await created.json()).data.id
  const accepted = await send(fresh)
  assert.equal(accepted.status, 200, await accepted.text())
  assert.equal(forwarded, 1)
  // Reset must not forget the healthy admission, even after restarting access.
  await access.action({ type: "reset" })
  await access.close()
  access = await createMobileAccess(options)
  token = await pair()
  assert.equal((await send(fresh)).status, 200)
  assert.equal((await send(fresh, "Changed prompt")).status, 409)
  assert.equal((await send("ses_old")).status, 409)
  assert.equal(forwarded, 1)
})
