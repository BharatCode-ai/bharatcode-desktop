import { resolveChannel } from "./utils"
import { BRANDING, appIdForChannel, normalizeChannel, productNameForChannel } from "../src/main/branding"

const arg = process.argv[2]
const channel = normalizeChannel(arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel())

const appId = appIdForChannel(channel)
const productName = productNameForChannel(channel)
const summary = `BharatCode OAuth coding agent${channel !== "prod" ? ` (${channel})` : ""}`

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="ai.bharatcode">
    <name>BharatCode</name>
  </developer>

  <description>
    <p>
      BharatCode is an OAuth-first coding agent based on OpenCode.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

  <url type="bugtracker">${BRANDING.bugtracker}</url>
  <url type="homepage">${BRANDING.homepage}</url>
  <url type="vcs-browser">${BRANDING.repo.url}</url>

  <screenshots>
    <screenshot type="default">
      <image>https://raw.githubusercontent.com/anomalyco/opencode/b75d4d1c5ec449585d515c756fc81f080a157a9a/packages/web/src/assets/lander/screenshot.png</image>
    </screenshot>
  </screenshots>
</component>
`

await Bun.write(`resources/${appId}.metainfo.xml`, xml)
console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`)
