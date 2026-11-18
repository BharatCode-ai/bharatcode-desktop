// Network-free stand-in for gh/curl in the publication integration test.
// Unknown commands fail, and downloads come only from the uploaded byte store.
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

const db = process.env.FIXTURE_DB
const state = JSON.parse(fs.readFileSync(db, "utf8"))
const [tool, op, arg, ...rest] = process.argv.slice(2)
const get = (tag) => state.releases.find((r) => r.tag_name === tag)
const save = (event) => {
  state.events.push(event)
  fs.writeFileSync(db, JSON.stringify(state))
}
const print = (data) => console.log(JSON.stringify(data))
const stop = (event) => {
  if (event === process.env.FIXTURE_INTERRUPT) throw Error("injected interruption: " + event)
}
if (tool === "curl") {
  const url = new URL(rest.at(-1))
  const [, owner, repo, releases, download, tag, name] = url.pathname.split("/")
  if (
    url.origin !== "https://github.com" ||
    owner !== "BharatCode-ai" ||
    repo !== "bharatcode-desktop" ||
    releases !== "releases" ||
    download !== "download" ||
    get(tag)?.draft !== false
  )
    throw Error("not public")
  stop("download:" + tag + "/" + name)
  save("download:" + tag + "/" + name)
  process.stdout.write(Buffer.from(get(tag).assets.find((a) => a.name === name).data, "base64"))
} else if (tool === "gh" && op === "release" && arg === "upload") {
  const [tag, file] = rest
  const name = path.basename(file)
  const release = get(tag)
  if (!release.draft || release.assets.some((a) => a.name === name) || rest.includes("--clobber"))
    throw Error("overwrite")
  stop("upload:" + tag + "/" + name)
  const data = fs.readFileSync(file)
  release.assets.push({
    name,
    digest: "sha256:" + createHash("sha256").update(data).digest("hex"),
    state: "uploaded",
    data: data.toString("base64"),
  })
  save("upload:" + tag + "/" + name)
} else if (tool === "gh" && op === "api") {
  const route = arg.replace(/^repos\/BharatCode-ai\/bharatcode-desktop\//, "")
  if (route === "releases?per_page=100") print([state.releases])
  else if (route.startsWith("git/matching-refs/tags/")) {
    const tag = route.slice("git/matching-refs/tags/".length)
    print(state.refs[tag] ? [{ ref: "refs/tags/" + tag, object: { type: "commit", sha: state.refs[tag] } }] : [])
  } else if (route === "releases" && rest.includes("POST")) {
    const release = {
      ...JSON.parse(fs.readFileSync(0, "utf8")),
      id: state.releases.length + 1,
      assets: [],
      immutable: false,
    }
    if (!release.draft || get(release.tag_name)) throw Error("not a new draft")
    state.releases.push(release)
    save("draft:" + release.tag_name)
    print(release)
  } else if (route.startsWith("releases/tags/")) print(get(route.slice("releases/tags/".length)))
  else if (/^releases\/\d+$/.test(route)) {
    const release = state.releases.find((r) => r.id === Number(route.split("/")[1]))
    if (rest.includes("PATCH")) {
      if (
        !release.draft ||
        !rest.includes("draft=false") ||
        !rest.includes("prerelease=" + release.prerelease) ||
        !rest.includes("make_latest=false") ||
        state.refs[release.tag_name]
      )
        throw Error("unexpected PATCH")
      release.draft = false
      release.immutable = true
      state.refs[release.tag_name] = release.target_commitish
      save("publish:" + release.tag_name)
    }
    print(release)
  } else throw Error("unknown API route: " + arg)
} else throw Error("unknown fixture command")
