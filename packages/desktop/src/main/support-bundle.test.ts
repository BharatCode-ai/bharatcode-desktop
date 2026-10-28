import { expect, describe, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { existsSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { BlobReader, ZipReader } from "@zip.js/zip.js"
import {
  redactString,
  redactObject,
  checkDatabaseHealth,
  generateSupportBundle,
  collectRedactedLogs,
} from "./support-bundle"

async function safeRm(path: string) {
  for (let i = 0; i < 5; i++) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

describe("support-bundle redaction and diagnostics", () => {
  const sampleOpenAI = ["sk", "abcdef12345678901234567890"].join("-")
  const sampleAnthropic = ["sk", "ant", "api03-abcdefghijklmnopqrstuvwxyz1234567890"].join("-")
  const sampleGitHub = ["ghp", "1234567890abcdefghijklmnopqrstuvwxyz1234"].join("_")
  const sampleSlack = ["xoxb", "123456789012", "abcdefghijklmnopqrstuvwx"].join("-")

  test("redactString scrubs API keys, private keys, bearer tokens, passwords, and user paths", () => {
    const raw = [
      `OpenAI Key: ${sampleOpenAI}`,
      `Anthropic Key: ${sampleAnthropic}`,
      `GitHub Token: ${sampleGitHub}`,
      `Slack Token: ${sampleSlack}`,
      "Auth header: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDN7BhCLtGPN5Qtr6AYbgXA20dfmtAedYnKcPAJ80",
      "Basic auth: Basic YWRtaW46cGFzc3dvcmQ=",
      "Database URL: postgres://admin:super_secret_pw123@localhost:5432/db",
      'JSON log: {"access_token": "secret_token_123", "refresh_token": "refresh_abc_456", "password": "my_plain_pass"}',
      'Prompt: {"prompt": "Summarize my confidential financial statement for Q3"}',
      "User path: C:\\Users\\sivaram\\project\\file.ts and /Users/sivaram/repo/app.ts",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA0Y3y...",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n")

    const scrubbed = redactString(raw, { homeDir: "C:\\Users\\sivaram" })

    expect(scrubbed).not.toContain(sampleOpenAI)
    expect(scrubbed).not.toContain(sampleAnthropic)
    expect(scrubbed).not.toContain(sampleGitHub)
    expect(scrubbed).not.toContain(sampleSlack)
    expect(scrubbed).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")
    expect(scrubbed).not.toContain("YWRtaW46cGFzc3dvcmQ=")
    expect(scrubbed).not.toContain("super_secret_pw123")
    expect(scrubbed).not.toContain("secret_token_123")
    expect(scrubbed).not.toContain("refresh_abc_456")
    expect(scrubbed).not.toContain("my_plain_pass")
    expect(scrubbed).not.toContain("Summarize my confidential financial statement for Q3")
    expect(scrubbed).not.toContain("C:\\Users\\sivaram")
    expect(scrubbed).not.toContain("/Users/sivaram")
    expect(scrubbed).not.toContain("MIIEowIBAAKCAQEA0Y3y")

    expect(scrubbed).toContain("[REDACTED_OPENAI_KEY]")
    expect(scrubbed).toContain("[REDACTED_ANTHROPIC_KEY]")
    expect(scrubbed).toContain("[REDACTED_GITHUB_TOKEN]")
    expect(scrubbed).toContain("[REDACTED_SLACK_TOKEN]")
    expect(scrubbed).toContain("Bearer [REDACTED]")
    expect(scrubbed).toContain("Basic [REDACTED]")
    expect(scrubbed).toContain("[REDACTED_PROMPT]")
    expect(scrubbed).toContain("<USER_HOME>")
    expect(scrubbed).toContain("[REDACTED_PRIVATE_KEY]")
  })

  test("redactObject deeply scrubs sensitive keys and string values", () => {
    const sensitive = {
      user: {
        id: "usr_1",
        email: "user@example.com",
        password: "clear_password_123",
        token: "tok_secret_value",
      },
      config: {
        apiKey: sampleOpenAI,
        path: "C:\\Users\\admin\\secrets.env",
      },
      prompts: [
        { role: "user", content: "Tell me the secret launch codes" },
        { role: "assistant", content: "Here is the answer" },
      ],
    }

    const scrubbed = redactObject(sensitive, { homeDir: "C:\\Users\\admin" })

    expect(scrubbed.user.password).toBe("[REDACTED]")
    expect(scrubbed.user.token).toBe("[REDACTED]")
    expect(scrubbed.config.apiKey).toBe("[REDACTED]")
    expect(scrubbed.config.path).toBe("<USER_HOME>\\secrets.env")
    expect(scrubbed.prompts[0].content).toBe("[REDACTED_PROMPT]")
    expect(scrubbed.prompts[1].content).toBe("[REDACTED_PROMPT]")
  })

  test("checkDatabaseHealth inspects SQLite database and returns table statistics safely", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-health-test-"))
    const dbPath = join(dir, "health.db")

    try {
      const db = new Database(dbPath)
      db.run("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)")
      db.run("CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT)")
      db.run("INSERT INTO session VALUES ('s1', 'first session')")
      db.run("INSERT INTO session VALUES ('s2', 'second session')")
      db.run("INSERT INTO message VALUES ('m1', 'hello')")
      db.close()

      const health = await checkDatabaseHealth(dbPath)

      expect(health.exists).toBe(true)
      expect(health.integrityOk).toBe(true)
      expect(health.checks).toEqual(["ok"])
      expect(health.tableCounts.session).toBe(2)
      expect(health.tableCounts.message).toBe(1)
    } finally {
      await safeRm(dir)
    }
  })

  test("generateSupportBundle creates a valid zip containing sanitized manifest, system info, and logs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-bundle-test-"))
    const dbPath = join(dir, "bundle.db")
    const logDir = join(dir, "logs")
    mkdirSync(logDir, { recursive: true })

    // Create mock log file with secrets that must be scrubbed
    writeFileSync(
      join(logDir, "main.log"),
      `INFO: Server started with key ${sampleOpenAI} on path C:\\Users\\johndoe\\repo\n`,
    )

    const db = new Database(dbPath)
    db.run("CREATE TABLE session (id TEXT PRIMARY KEY); INSERT INTO session VALUES ('1')")
    db.close()

    try {
      const result = await generateSupportBundle({
        outputDir: dir,
        dbPath,
      })

      expect(existsSync(result.outputPath)).toBe(true)
      expect(result.outputPath.endsWith(".zip")).toBe(true)
      expect(result.fileCount).toBeGreaterThanOrEqual(4)
      expect(result.databaseHealth.integrityOk).toBe(true)

      // Open the generated zip and inspect contents
      const zipBytes = await Bun.file(result.outputPath).arrayBuffer()
      const reader = new ZipReader(new BlobReader(new Blob([zipBytes])))
      const entries = await reader.getEntries()
      const entryNames = entries.map((e) => e.filename)

      expect(entryNames).toContain("manifest.json")
      expect(entryNames).toContain("system-info.json")
      expect(entryNames).toContain("database-health.json")
      expect(entryNames).toContain("config-sanitized.json")

      // Extract and check manifest
      const manifestEntry = entries.find((e) => e.filename === "manifest.json")
      expect(manifestEntry).toBeDefined()
      const textWriter = new (await import("@zip.js/zip.js")).TextWriter()
      const manifestText = await manifestEntry!.getData!(textWriter)
      expect(manifestText).toContain("bharatcode-support-bundle")

      await reader.close()
    } finally {
      await safeRm(dir)
    }
  })
})

describe("redactString leaks", () => {
  const home = { homeDir: "/home/zzz" }
  // [input, the secret that must not survive]
  const cases: [string, string][] = [
    ["Authorization: Token abcdef1234567890SECRETVALUE", "abcdef1234567890SECRETVALUE"],
    ["Authorization: Bearer abc123", "abc123"],
    ["Cookie: session=abcdef123456; other=zzz", "abcdef123456"],
    ["Set-Cookie: sid=SESSIONVALUE99; HttpOnly", "SESSIONVALUE99"],
    ["x-api-key: KEY1234567890abc", "KEY1234567890abc"],
    [
      `jwt ${["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV"].join(".")}`,
      "eyJzdWIi",
    ],
    [`${["github", "pat"].join("_")}_11ABCDEFG0abcdefghijklmnop`, `${["github", "pat"].join("_")}_11ABCDEFG0`],
    [`AWS_ACCESS_KEY_ID=${["AKIA", "IOSFODNN7EXAMPLE"].join("")}`, ["AKIA", "IOSFODNN7EXAMPLE"].join("")],
    ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI"],
    ["GET /cb?code=abc123XYZsecret&state=q", "abc123XYZsecret"],
    ["?api-key=KEY12345678", "KEY12345678"],
    ['{"password": "my pass phrase"}', "pass phrase"],
    ['{"password":"ab\\"cd"}', "cd"],
    ["https://user:p@ss:word@host/x", "ss:word"],
    [`key ${["AIza", "SyA1234567890abcdefghijklmnopqrstuv"].join("")}`, ["AIza", "SyA1234567890"].join("")],
    ["key sk-or-v1-abc123", "abc123"],
    ["contact bob@example.com", "bob@example.com"],
    ["from 192.168.1.23", "192.168.1.23"],
    ["mac aa:bb:cc:dd:ee:ff", "aa:bb:cc:dd:ee:ff"],
    ["-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqh", "MIIEvQIBADANBgkqh"],
    ["/root/.ssh/id_rsa", "/root"],
  ]

  for (const [input, secret] of cases) {
    test(input.slice(0, 40), () => {
      expect(redactString(input, home)).not.toContain(secret)
    })
  }

  test("keeps ordinary diagnostics readable", () => {
    const line = "max_tokens: 4096 version 1.15.35 task-runner started on 127.0.0.1"
    expect(redactString(line, home)).toBe(line)
  })
})

describe("redactObject keys", () => {
  test("hides camelCase, header, env and nested prompt values", () => {
    const out = JSON.stringify(
      redactObject({
        apiToken: "abcTOK",
        accessToken: "AT1",
        clientSecret: "CS1",
        refreshToken: "RT1",
        headers: { cookie: "sid=SS1", "x-api-key": "KK1" },
        env: { OPENAI_API_KEY: "envkey1", DB_PASSWORD: "pw1" },
        messages: [{ content: { parts: ["nested prompt"] } }],
      }),
    )
    for (const secret of ["abcTOK", "AT1", "CS1", "RT1", "SS1", "KK1", "envkey1", "pw1", "nested prompt"]) {
      expect(out).not.toContain(secret)
    }
  })

  test("keeps harmless counters and author fields", () => {
    expect(redactObject({ max_tokens: 4096, tokens: 12, author: "ok" })).toEqual({
      max_tokens: 4096,
      tokens: 12,
      author: "ok",
    })
  })
})

describe("collectRedactedLogs", () => {
  test("does not follow symlinks out of the log directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "bundle-links-"))
    try {
      const logs = join(root, "logs")
      mkdirSync(logs)
      writeFileSync(join(root, "private.txt"), "PRIVATE-FILE-CONTENT")
      writeFileSync(join(logs, "main.log"), "hello")
      symlinkSync(join(root, "private.txt"), join(logs, "link.log"))

      const names = collectRedactedLogs(logs, "logs").map((entry) => entry.name)
      expect(names).toEqual(["logs/main.log"])
    } finally {
      await safeRm(root)
    }
  })
})
