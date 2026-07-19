import { afterEach, describe, expect, test } from "bun:test"
import { Option, Redacted } from "effect"
import { ServerAuth } from "../../src/server/auth"

const original = {
  password: process.env.BHARATCODE_SERVER_PASSWORD,
  username: process.env.BHARATCODE_SERVER_USERNAME,
}

afterEach(() => {
  if (original.password === undefined) delete process.env.BHARATCODE_SERVER_PASSWORD
  else process.env.BHARATCODE_SERVER_PASSWORD = original.password
  if (original.username === undefined) delete process.env.BHARATCODE_SERVER_USERNAME
  else process.env.BHARATCODE_SERVER_USERNAME = original.username
})

describe("ServerAuth", () => {
  test("does not emit auth headers without a password", () => {
    delete process.env.BHARATCODE_SERVER_PASSWORD
    process.env.BHARATCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.header()).toBeUndefined()
    expect(ServerAuth.headers()).toBeUndefined()
  })

  test("defaults to the BharatCode username", () => {
    process.env.BHARATCODE_SERVER_PASSWORD = "secret"
    delete process.env.BHARATCODE_SERVER_USERNAME

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("bharatcode:secret").toString("base64")}`,
    })
  })

  test("uses the configured username", () => {
    process.env.BHARATCODE_SERVER_PASSWORD = "secret"
    process.env.BHARATCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    })
  })

  test("prefers explicit credentials", () => {
    process.env.BHARATCODE_SERVER_PASSWORD = "secret"
    process.env.BHARATCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers({ password: "cli-secret", username: "bob" })).toEqual({
      Authorization: `Basic ${Buffer.from("bob:cli-secret").toString("base64")}`,
    })
  })

  test("validates decoded credentials against effect config", () => {
    const config = { password: Option.some("secret"), username: "alice" }

    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("secret") }, config)).toBe(true)
    expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("secret") }, config)).toBe(false)
  })
})
