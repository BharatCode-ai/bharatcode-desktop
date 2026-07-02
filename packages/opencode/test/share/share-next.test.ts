import { NodeFileSystem } from "@effect/platform-node"
import { beforeEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { Effect, Exit, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

import { AccessToken, AccountID, OrgID, RefreshToken } from "../../src/account/schema"
import { Account } from "../../src/account/account"
import { AccountRepo } from "../../src/account/repo"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Bus } from "../../src/bus"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Session, fromRow as sessionFromRow } from "@/session/session"
import type { SessionID } from "../../src/session/schema"
import { ShareNext } from "@/share/share-next"
import { SessionShareTable } from "../../src/share/share.sql"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const env = Layer.mergeAll(
  Session.defaultLayer,
  AccountRepo.layer,
  NodeFileSystem.layer,
  CrossSpawnSpawner.defaultLayer,
)
const it = testEffect(env)

const json = (req: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const none = HttpClient.make(() => Effect.die("unexpected http call"))
const BHARATCODE_SHARE_BASE_URL = "https://bharatcode.ai"

const shareEnvKeys = [
  "BHARATCODE_SHARE_BASE_URL",
  "BHARATCODE_SHARE_ACCESS_TOKEN",
  "BHARATCODE_ACCESS_TOKEN",
  "BHARATCODE_CREDENTIALS_PATH",
]

function withShareEnv<A, E, R>(values: Record<string, string | undefined>, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = new Map(shareEnvKeys.map((key) => [key, process.env[key]] as const))
      for (const key of shareEnvKeys) delete process.env[key]
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      return () => {
        for (const key of shareEnvKeys) delete process.env[key]
        for (const [key, value] of previous) {
          if (value !== undefined) process.env[key] = value
        }
      }
    }),
    () => effect,
    (restore) => Effect.sync(restore),
  )
}

function live(client: HttpClient.HttpClient) {
  const http = Layer.succeed(HttpClient.HttpClient, client)
  return ShareNext.layer.pipe(
    Layer.provide(Bus.layer),
    Layer.provide(Account.layer.pipe(Layer.provide(AccountRepo.layer), Layer.provide(http))),
    Layer.provide(Config.defaultLayer),
    Layer.provide(http),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Session.defaultLayer),
  )
}

function wired(client: HttpClient.HttpClient) {
  const http = Layer.succeed(HttpClient.HttpClient, client)
  return Layer.mergeAll(
    Bus.layer,
    ShareNext.layer,
    Session.defaultLayer,
    AccountRepo.layer,
    NodeFileSystem.layer,
    CrossSpawnSpawner.defaultLayer,
  ).pipe(
    Layer.provide(Bus.layer),
    Layer.provide(Account.layer.pipe(Layer.provide(AccountRepo.layer), Layer.provide(http))),
    Layer.provide(Config.defaultLayer),
    Layer.provide(http),
    Layer.provide(Provider.defaultLayer),
  )
}

const share = (id: SessionID) =>
  Database.use((db) => db.select().from(SessionShareTable).where(eq(SessionShareTable.session_id, id)).get())

const seed = (url: string, org?: string) =>
  AccountRepo.Service.use((repo) =>
    repo.persistAccount({
      id: AccountID.make("account-1"),
      email: "user@example.com",
      url,
      accessToken: AccessToken.make("st_test_token"),
      refreshToken: RefreshToken.make("rt_test_token"),
      expiry: Date.now() + 10 * 60_000,
      orgID: org ? Option.some(OrgID.make(org)) : Option.none(),
    }),
  )

beforeEach(async () => {
  await resetDatabase()
})

describe("ShareNext", () => {
  it.live("request uses BharatCode share API without active org account", () =>
    withShareEnv(
      { BHARATCODE_SHARE_ACCESS_TOKEN: "bc_test_token" },
      provideTmpdirInstance(() =>
        ShareNext.Service.use((svc) =>
          Effect.gen(function* () {
            const req = yield* svc.request()

            expect(req.api.create).toBe("/api/share")
            expect(req.api.sync("shr_123")).toBe("/api/share/shr_123/sync")
            expect(req.api.remove("shr_123")).toBe("/api/share/shr_123")
            expect(req.api.data("shr_123")).toBe("/api/share/shr_123/data")
            expect(req.baseUrl).toBe(BHARATCODE_SHARE_BASE_URL)
            expect(req.headers).toEqual({ authorization: "Bearer bc_test_token" })
          }),
        ).pipe(Effect.provide(live(none))),
      ),
    ),
  )

  it.live("request uses configured BharatCode share base URL", () =>
    withShareEnv(
      {
        BHARATCODE_SHARE_ACCESS_TOKEN: "bc_test_token",
        BHARATCODE_SHARE_BASE_URL: "http://127.0.0.1:4000",
      },
      provideTmpdirInstance(() =>
        ShareNext.Service.use((svc) =>
          Effect.gen(function* () {
            const req = yield* svc.request()

            expect(req.baseUrl).toBe("http://127.0.0.1:4000")
            expect(req.api.create).toBe("/api/share")
            expect(req.headers).toEqual({ authorization: "Bearer bc_test_token" })
          }),
        ).pipe(Effect.provide(live(none))),
      ),
    ),
  )

  it.live("request reads BharatCode OAuth credentials when no explicit token is set", () =>
    withShareEnv(
      {},
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const credentialsPath = join(dir, "credentials", "credentials.json")
          yield* Effect.promise(async () => {
            await mkdir(dirname(credentialsPath), { recursive: true })
            await writeFile(
              credentialsPath,
              JSON.stringify({
                access_token: "stored_bc_token",
                refresh_token: "stored_refresh_token",
                expires_at: Math.floor(Date.now() / 1000) + 3600,
              }),
            )
            process.env.BHARATCODE_CREDENTIALS_PATH = credentialsPath
          })

          const req = yield* ShareNext.use.request().pipe(Effect.provide(live(none)))

          expect(req.baseUrl).toBe(BHARATCODE_SHARE_BASE_URL)
          expect(req.headers).toEqual({ authorization: "Bearer stored_bc_token" })
        }),
      ),
    ),
  )

  it.live("request rejects OpenCode share base URLs", () =>
    withShareEnv(
      {
        BHARATCODE_SHARE_ACCESS_TOKEN: "bc_test_token",
        BHARATCODE_SHARE_BASE_URL: "https://opncd.ai",
      },
      provideTmpdirInstance(() =>
        ShareNext.Service.use((svc) => Effect.exit(svc.request())).pipe(
          Effect.map((exit) => {
            expect(Exit.isFailure(exit)).toBe(true)
          }),
          Effect.provide(live(none)),
        ),
      ),
    ),
  )

  it.live("create rejects non-BharatCode share URLs returned by the server", () =>
    withShareEnv(
      { BHARATCODE_SHARE_ACCESS_TOKEN: "bc_test_token" },
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const session = yield* Session.use.create({ title: "test" })
          const client = HttpClient.make((req) =>
            Effect.succeed(
              json(req, {
                id: "shr_abc",
                url: "https://opncd.ai/s/shr_abc",
                secret: "sec_123",
              }),
            ),
          )

          const exit = yield* ShareNext.Service.use((svc) => Effect.exit(svc.create(session.id))).pipe(
            Effect.provide(live(client)),
          )

          expect(Exit.isFailure(exit)).toBe(true)
          expect(share(session.id)).toBeUndefined()
        }),
      ),
    ),
  )

  test("BharatCode share client has no OpenCode share fallback or raw share failure logging", async () => {
    const source = await readFile(resolve(import.meta.dir, "../../src/share/share-next.ts"), "utf8")

    expect(source).not.toContain("https://opncd.ai")
    expect(source).not.toContain("https://opencode.ai")
    expect(source).not.toContain("/api/shares")
    expect(source).not.toContain("x-org-id")
    expect(source).toContain('log.error("BharatCode share flush failed", { sessionID })')
    expect(source).toContain('log.error("BharatCode share full sync failed", { sessionID })')
    expect(source).not.toContain('log.error("BharatCode share flush failed", { sessionID, cause')
    expect(source).not.toContain('log.error("BharatCode share full sync failed", { sessionID, cause')
  })

  test("session mapper hides persisted non-BharatCode share URLs", () => {
    const row = {
      id: "ses_1",
      project_id: "proj_1",
      workspace_id: null,
      parent_id: null,
      slug: "test",
      directory: "/tmp",
      path: null,
      title: "test",
      version: "test",
      share_url: "https://opncd.ai/s/shr_abc",
      summary_additions: null,
      summary_deletions: null,
      summary_files: null,
      summary_diffs: null,
      cost: 0,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      revert: null,
      permission: null,
      goal: null,
      agent: null,
      model: null,
      time_created: 1,
      time_updated: 1,
      time_compacting: null,
      time_archived: null,
    }

    expect(sessionFromRow(row as never).share).toBeUndefined()
    expect(sessionFromRow({ ...row, share_url: "https://bharatcode.ai/share/shr_abc" } as never).share?.url).toBe(
      "https://bharatcode.ai/share/shr_abc",
    )
  })

  it.live("request ignores legacy enterprise share config in BharatCode Desktop mode", () =>
    withShareEnv(
      { BHARATCODE_SHARE_ACCESS_TOKEN: "bc_test_token" },
      provideTmpdirInstance(
        () =>
          ShareNext.Service.use((svc) =>
            Effect.gen(function* () {
              const req = yield* svc.request()

              expect(req.api.create).toBe("/api/share")
              expect(req.api.sync("shr_123")).toBe("/api/share/shr_123/sync")
              expect(req.api.remove("shr_123")).toBe("/api/share/shr_123")
              expect(req.api.data("shr_123")).toBe("/api/share/shr_123/data")
              expect(req.baseUrl).toBe(BHARATCODE_SHARE_BASE_URL)
              expect(req.headers).toEqual({ authorization: "Bearer bc_test_token" })
            }),
          ).pipe(Effect.provide(live(none))),
        { config: { enterprise: { url: "https://legacy-share.example.com" } } },
      ),
    ),
  )

  it.live("request uses canonical BharatCode URL when no enterprise config", () =>
    withShareEnv(
      { BHARATCODE_SHARE_ACCESS_TOKEN: "bc_test_token" },
      provideTmpdirInstance(() =>
        ShareNext.Service.use((svc) =>
          Effect.gen(function* () {
            const req = yield* svc.request()

            expect(req.baseUrl).toBe(BHARATCODE_SHARE_BASE_URL)
            expect(req.api.create).toBe("/api/share")
            expect(req.headers).toEqual({ authorization: "Bearer bc_test_token" })
          }),
        ).pipe(Effect.provide(live(none))),
      ),
    ),
  )

  it.live("request ignores OpenCode org share API when account is active", () =>
    withShareEnv(
      { BHARATCODE_SHARE_ACCESS_TOKEN: "bc_test_token" },
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          yield* seed("https://control.example.com", "org-1")

          const req = yield* ShareNext.use.request().pipe(Effect.provide(live(none)))

          expect(req.api.create).toBe("/api/share")
          expect(req.api.sync("shr_123")).toBe("/api/share/shr_123/sync")
          expect(req.api.remove("shr_123")).toBe("/api/share/shr_123")
          expect(req.api.data("shr_123")).toBe("/api/share/shr_123/data")
          expect(req.baseUrl).toBe(BHARATCODE_SHARE_BASE_URL)
          expect(req.headers).toEqual({
            authorization: "Bearer bc_test_token",
          })
        }),
      ),
    ),
  )

  it.live("create posts share, persists it, and returns the result", () =>
    withShareEnv(
      { BHARATCODE_SHARE_ACCESS_TOKEN: "bc_test_token" },
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const session = yield* Session.use.create({ title: "test" })
          const seen: HttpClientRequest.HttpClientRequest[] = []
          const client = HttpClient.make((req) => {
            seen.push(req)
            if (req.url.endsWith("/api/share")) {
              return Effect.succeed(
                json(req, {
                  id: "shr_abc",
                  url: "https://bharatcode.ai/share/abc",
                  secret: "sec_123",
                }),
              )
            }
            return Effect.succeed(json(req, { ok: true }))
          })

          const result = yield* ShareNext.use.create(session.id).pipe(Effect.provide(live(client)))

          expect(result.id).toBe("shr_abc")
          expect(result.url).toBe("https://bharatcode.ai/share/abc")
          expect(result.secret).toBe("sec_123")

          const row = share(session.id)
          expect(row?.id).toBe("shr_abc")
          expect(row?.url).toBe("https://bharatcode.ai/share/abc")
          expect(row?.secret).toBe("sec_123")

          expect(seen).toHaveLength(1)
          expect(seen[0].method).toBe("POST")
          expect(seen[0].url).toBe("https://bharatcode.ai/api/share")
        }),
      ),
    ),
  )

  it.live("remove deletes the persisted share and calls the delete endpoint", () =>
    withShareEnv(
      { BHARATCODE_SHARE_ACCESS_TOKEN: "bc_test_token" },
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const session = yield* Session.use.create({ title: "test" })
          const seen: HttpClientRequest.HttpClientRequest[] = []
          const client = HttpClient.make((req) => {
            seen.push(req)
            if (req.method === "POST") {
              return Effect.succeed(
                json(req, {
                  id: "shr_abc",
                  url: "https://bharatcode.ai/share/abc",
                  secret: "sec_123",
                }),
              )
            }
            return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 200 })))
          })

          yield* Effect.gen(function* () {
            yield* ShareNext.use.create(session.id)
            yield* ShareNext.use.remove(session.id)
          }).pipe(Effect.provide(live(client)))

          expect(share(session.id)).toBeUndefined()
          expect(seen.map((req) => [req.method, req.url])).toEqual([
            ["POST", "https://bharatcode.ai/api/share"],
            ["DELETE", "https://bharatcode.ai/api/share/shr_abc"],
          ])
        }),
      ),
    ),
  )

  it.live("create fails on a non-ok response and does not persist a share", () =>
    withShareEnv(
      { BHARATCODE_SHARE_ACCESS_TOKEN: "bc_test_token" },
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const session = yield* Session.use.create({ title: "test" })
          const client = HttpClient.make((req) => Effect.succeed(json(req, { error: "bad" }, 500)))

          const exit = yield* ShareNext.Service.use((svc) => Effect.exit(svc.create(session.id))).pipe(
            Effect.provide(live(client)),
          )

          expect(Exit.isFailure(exit)).toBe(true)
          expect(share(session.id)).toBeUndefined()
        }),
      ),
    ),
  )

  it.live("ShareNext coalesces rapid diff events into one delayed sync with latest data", () =>
    withShareEnv(
      { BHARATCODE_SHARE_ACCESS_TOKEN: "bc_test_token" },
      provideTmpdirInstance(() => {
        const seen: Array<{ url: string; body: string }> = []
        const client = HttpClient.make((req) => {
          if (req.url.endsWith("/sync") && req.body._tag === "Uint8Array") {
            seen.push({ url: req.url, body: new TextDecoder().decode(req.body.body) })
          }
          return Effect.succeed(json(req, { ok: true }))
        })

        return Effect.gen(function* () {
          const bus = yield* Bus.Service
          const share = yield* ShareNext.Service
          const session = yield* Session.Service

          const info = yield* session.create({ title: "first" })
          yield* share.init()
          yield* Effect.sleep(50)
          yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .insert(SessionShareTable)
                .values({
                  session_id: info.id,
                  id: "shr_abc",
                  url: "https://bharatcode.ai/share/abc",
                  secret: "sec_123",
                })
                .run(),
            ),
          )

          yield* bus.publish(Session.Event.Diff, {
            sessionID: info.id,
            diff: [
              {
                file: "a.ts",
                patch:
                  "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,1 +1,1 @@\n-one\n\\ No newline at end of file\n+two\n\\ No newline at end of file\n",
                additions: 1,
                deletions: 1,
                status: "modified",
              },
            ],
          })
          yield* bus.publish(Session.Event.Diff, {
            sessionID: info.id,
            diff: [
              {
                file: "b.ts",
                patch:
                  "Index: b.ts\n===================================================================\n--- b.ts\t\n+++ b.ts\t\n@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
                additions: 2,
                deletions: 0,
                status: "modified",
              },
            ],
          })
          yield* Effect.sleep(1_250)

          expect(seen).toHaveLength(1)
          expect(seen[0].url).toBe("https://bharatcode.ai/api/share/shr_abc/sync")

          const body = JSON.parse(seen[0].body) as {
            secret: string
            data: Array<{
              type: string
              data: Array<{
                file: string
                patch: string
                additions: number
                deletions: number
                status?: string
              }>
            }>
          }
          expect(body.secret).toBe("sec_123")
          expect(body.data).toHaveLength(1)
          expect(body.data[0].type).toBe("session_diff")
          expect(body.data[0].data).toEqual([
            {
              file: "b.ts",
              patch:
                "Index: b.ts\n===================================================================\n--- b.ts\t\n+++ b.ts\t\n@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
              additions: 2,
              deletions: 0,
              status: "modified",
            },
          ])
        }).pipe(Effect.provide(wired(client)))
      }),
    ),
  )
})
