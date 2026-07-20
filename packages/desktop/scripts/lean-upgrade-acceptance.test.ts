import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { Database } from "bun:sqlite"

import * as acceptance from "./lean-upgrade-acceptance.mjs"
import {
  parseUpgradeAcceptanceArguments,
  runLeanUpgradeAcceptance,
  validateCurrentBetaApiObservation,
  validateUpgradeExecutionObservation,
  verifyPinnedInstaller,
} from "./lean-upgrade-acceptance.mjs"
import { canonicalLeanJson, parseCurrentBetaFixtureBytes } from "./lean-upgrade-receipt.mjs"

const sourceSha = "3b09dcff0d7e8ad7487c6d40199b704ed0712005"
const fixturePath = resolve(import.meta.dir, "../test/fixtures/current-beta-windows-x64.json")
const candidate = {
  key: "desktop-windows-x64",
  filename: "bharatcode-desktop-next-beta-win-x64.exe",
  bytes: 120_000_000,
  sha256: "a".repeat(64),
}
const session = { id: "ses_upgrade_acceptance", title: "Preserved packaged beta session" }

function pe() {
  return Buffer.concat([Buffer.from("MZ"), Buffer.alloc(16), Buffer.from("PE\0\0"), Buffer.alloc(16)])
}

async function currentBeta() {
  return parseCurrentBetaFixtureBytes(new Uint8Array(await Bun.file(fixturePath).arrayBuffer()))
}

function checks() {
  return {
    current_beta_download_verified: true,
    current_beta_installed_and_started: true,
    eligible_state_seeded: true,
    candidate_installed_over_beta: true,
    eligible_state_preserved: true,
    candidate_started: true,
    bharatcode_runtime_only: true,
    rollback_installed: true,
    rollback_state_structurally_valid: true,
    migration_source_preserved: true,
    recovery_evidence_preserved: true,
    sharenext_absent: true,
    share_network_attempt_absent: true,
  }
}

function observation() {
  return {
    schema: "bharatcode-packaged-upgrade-observation-v1",
    candidate: { ...candidate },
    checks: checks(),
    cleanup_complete: true,
  }
}

async function fixture(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "lean-upgrade-acceptance-"))
  const acceptanceDirectory = join(root, "acceptance")
  const localFixture = join(root, "current-beta.json")
  const candidatePath = join(root, candidate.filename)
  await writeFile(localFixture, canonicalLeanJson(await currentBeta()))
  await writeFile(candidatePath, "candidate")
  const argv = [
    "--fixture",
    localFixture,
    "--candidate",
    candidatePath,
    "--source-sha",
    sourceSha,
    "--acceptance-dir",
    acceptanceDirectory,
  ]
  const dependencies = {
    platform: "win32",
    arch: "x64",
    env: {
      GITHUB_ACTIONS: "true",
      GITHUB_RUN_ID: "123456789",
      GITHUB_RUN_ATTEMPT: "2",
      RUNNER_OS: "Windows",
      RUNNER_ARCH: "X64",
      RUNNER_ENVIRONMENT: "github-hosted",
      ImageOS: "win25",
      ImageVersion: "20260713.1.0",
    },
    now: () => new Date("2026-07-20T10:00:00.000Z"),
    execute: async () => observation(),
    ...overrides,
  }
  return { root, acceptanceDirectory, localFixture, candidatePath, argv, dependencies }
}

describe("real packaged Windows upgrade and rollback acceptance", () => {
  test("accepts only the exact closed CLI and immutable candidate filename", async () => {
    const input = await fixture()
    try {
      expect(parseUpgradeAcceptanceArguments(input.argv)).toEqual({
        fixture: input.localFixture,
        candidate: input.candidatePath,
        sourceSha,
        acceptanceDirectory: input.acceptanceDirectory,
      })
      for (const hostile of [
        input.argv.slice(0, -2),
        [...input.argv, "--extra", "value"],
        input.argv.map((value) => (value === sourceSha ? "0".repeat(40) : value)),
        input.argv.map((value) => (value === input.candidatePath ? join(input.root, "candidate.exe") : value)),
      ]) {
        expect(() => parseUpgradeAcceptanceArguments(hostile)).toThrow()
      }
    } finally {
      await rm(input.root, { recursive: true, force: true })
    }
  })

  test("discovers exactly BharatCode Beta.exe and closes the owned utility process tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "lean-upgrade-installed-"))
    const executable = join(root, "BharatCode Beta.exe")
    try {
      await writeFile(executable, pe())
      await writeFile(join(root, "Uninstall BharatCode Beta.exe"), pe())
      expect(await acceptance.discoverPackagedApplication(root)).toEqual({ executable })

      const records = [
        {
          process_id: 4100,
          parent_process_id: 1,
          executable_path: executable,
          command_line: `"${executable}" --disable-gpu`,
        },
        {
          process_id: 4101,
          parent_process_id: 4100,
          executable_path: executable,
          command_line: `"${executable}" --type=utility --utility-sub-type=node.mojom.NodeService`,
        },
      ]
      expect(acceptance.validateOwnedProcessTree(records, { rootPid: 4100, executable })).toEqual({
        rootPid: 4100,
        utilityPid: 4101,
        pids: [4100, 4101],
      })
      expect(acceptance.validateOwnedProcessesGone([4100, 4101], [])).toBeTrue()
      expect(() => acceptance.validateOwnedProcessesGone([4100, 4101], [records[1]])).toThrow()
      expect(() => acceptance.validateOwnedProcessTree(records.slice(0, 1), { rootPid: 4100, executable })).toThrow()
      expect(() =>
        acceptance.validateOwnedProcessTree(
          [records[0], { ...records[1], executable_path: join(root, "substituted.exe") }],
          { rootPid: 4100, executable },
        ),
      ).toThrow()

      await rm(executable)
      await expect(acceptance.discoverPackagedApplication(root)).rejects.toThrow(/missing|exactly one/i)
      await writeFile(executable, pe())
      await writeFile(join(root, "Another.exe"), pe())
      await expect(acceptance.discoverPackagedApplication(root)).rejects.toThrow(/ambiguous|exactly one/i)

      const source = await readFile(new URL("./lean-upgrade-acceptance.mjs", import.meta.url), "utf8")
      expect(source).not.toContain('const INSTALLED_EXECUTABLE = "bharatcode-beta.exe"')
      const branding = await readFile(new URL("../src/main/branding.ts", import.meta.url), "utf8")
      expect(branding).toContain('appName: "BharatCode"')
      expect(branding).toContain("return `${BRANDING.appName} ${channel.charAt(0).toUpperCase() + channel.slice(1)}`")
      expect(await readFile(new URL("../electron-builder.config.ts", import.meta.url), "utf8")).toContain(
        "productName: productNameForChannel(channel)",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("recognizes only the shipped post-initialization log and rejects premature or failed startup", () => {
    const prior = "[info] init step { step: { phase: 'done' } }\r\n"
    const healthy =
      "[info] sidecar connection started { url: 'http://127.0.0.1:43123' }\r\n" + `[2026-07-20 10:00:00.000] ${prior}`
    expect(acceptance.parsePackagedReadinessLog(healthy)).toBeTrue()
    expect(() => acceptance.parsePackagedReadinessDelta(prior, `${prior}[info] app starting\r\n`)).toThrow()
    expect(acceptance.parsePackagedReadinessDelta(prior, `${prior}${healthy}`)).toBeTrue()
    expect(() => acceptance.parsePackagedReadinessDelta(prior, `[info] truncated\r\n${healthy}`)).toThrow()
    for (const hostile of [
      "[info] app starting { version: '1.2.3', packaged: true }\r\n",
      '[info] init step { step: { phase: "server_waiting" } }\r\n',
      "[info] init step { step: { phase: done } }\r\n",
      "[error] sidecar exited before ready\r\n",
      `[error] sidecar health check failed Error: unavailable\r\n${healthy}`,
      `[error] utility process error: spawn failed\r\n${healthy}`,
      `[error] utility process gone reason=crashed\r\n${healthy}`,
      `[error] sidecar exited { code: 1 }\r\n${healthy}`,
      `[error] child process gone { reason: 'crashed' }\r\n${healthy}`,
    ]) {
      expect(() => acceptance.parsePackagedReadinessLog(hostile)).toThrow()
    }

    const executable = "C:\\Program Files\\BharatCode Beta\\BharatCode Beta.exe"
    const records = [
      {
        process_id: 4100,
        parent_process_id: 1,
        executable_path: executable,
        command_line: `"${executable}" --remote-debugging-port=43124`,
      },
      {
        process_id: 4101,
        parent_process_id: 4100,
        executable_path: executable,
        command_line: `"${executable}" --type=utility --utility-sub-type=node.mojom.NodeService`,
      },
    ]
    expect(
      acceptance.validatePackagedReadinessObservation(
        { log_delta: healthy, processes: records },
        { rootPid: 4100, executable },
      ),
    ).toEqual({ rootPid: 4100, utilityPid: 4101, pids: [4100, 4101], sidecarOrigin: "http://127.0.0.1:43123" })
    expect(() =>
      acceptance.validatePackagedReadinessObservation(
        { log_delta: healthy, processes: records.slice(0, 1) },
        { rootPid: 4100, executable },
      ),
    ).toThrow(/utility|sidecar/i)
  })

  test("accepts only the exact legacy OpenCode recovery source and observation-derived preserved state", () => {
    const recovery = {
      state: "choose-source",
      sources: [
        {
          id: `opencode-cli-${"a".repeat(64)}`,
          label: "Existing BharatCode data · opencode-cli · aaaaaaaa",
          contentFingerprint: "b".repeat(64),
        },
      ],
    }
    expect(acceptance.selectLegacyRecoverySource(recovery)).toEqual({
      id: recovery.sources[0].id,
      contentFingerprint: recovery.sources[0].contentFingerprint,
    })
    for (const hostile of [
      { state: "start-fresh", reason: "no-source" },
      { ...recovery, sources: [] },
      { ...recovery, sources: [...recovery.sources, recovery.sources[0]] },
      { ...recovery, sources: [{ ...recovery.sources[0], label: "Existing BharatCode data · opencode-desktop" }] },
    ]) {
      expect(() => acceptance.selectLegacyRecoverySource(hostile)).toThrow()
    }

    const evidence = {
      schema: "bharatcode-packaged-state-evidence-v1",
      source: {
        database_before_sha256: "1".repeat(64),
        database_after_sha256: "1".repeat(64),
        config_before_sha256: "2".repeat(64),
        config_after_sha256: "2".repeat(64),
      },
      recovery: {
        selected_source_id: recovery.sources[0].id,
        selected_content_fingerprint: recovery.sources[0].contentFingerprint,
        actions: ["choose-source"],
        final_state: "ready",
        journal_sha256: "3".repeat(64),
        snapshot_verified: true,
        sentinels_absent: true,
      },
      candidate: {
        database_quick_check: "ok",
        session,
        config: { snapshot: false },
        account_state: "signed-out",
        credential_store_usable: false,
        sentinel_present: false,
      },
      rollback: {
        database_quick_check: "ok",
        session,
        config: { snapshot: false },
        legacy_account_intact: true,
      },
    }
    expect(acceptance.validateStateEvidence(evidence, session)).toEqual({
      eligibleStatePreserved: true,
      migrationSourcePreserved: true,
      recoveryEvidencePreserved: true,
      rollbackStateStructurallyValid: true,
    })
    for (const hostile of [
      { ...evidence, source: { ...evidence.source, database_after_sha256: "3".repeat(64) } },
      { ...evidence, recovery: { ...evidence.recovery, actions: ["start-fresh"] } },
      { ...evidence, recovery: { ...evidence.recovery, snapshot_verified: false } },
      { ...evidence, recovery: { ...evidence.recovery, sentinels_absent: false } },
      { ...evidence, recovery: { ...evidence.recovery, journal_sha256: "invalid" } },
      { ...evidence, candidate: { ...evidence.candidate, session: undefined } },
      { ...evidence, candidate: { ...evidence.candidate, credential_store_usable: true } },
      { ...evidence, candidate: { ...evidence.candidate, sentinel_present: true } },
      { ...evidence, rollback: { ...evidence.rollback, database_quick_check: "corrupt" } },
      { ...evidence, rollback: { ...evidence.rollback, legacy_account_intact: false } },
    ]) {
      expect(() => acceptance.validateStateEvidence(hostile, session)).toThrow()
    }

    const sentinels = ["bharatcode-cp3-inert-access-sentinel", "bharatcode-cp3-inert-refresh-sentinel"]
    expect(acceptance.observeCredentialStoreUsability([Buffer.from("{}"), Buffer.from(" \r\n")], sentinels)).toBeFalse()
    expect(
      acceptance.observeCredentialStoreUsability(
        [Buffer.from(JSON.stringify({ bharatcode: { access: "candidate-credential" } }))],
        sentinels,
      ),
    ).toBeTrue()
    expect(() => acceptance.observeCredentialStoreUsability([Buffer.from("not-json")], sentinels)).toThrow()
    expect(acceptance.observeCredentialSentinelPresence([Buffer.from("safe snapshot")], sentinels)).toBeFalse()
    expect(
      acceptance.observeCredentialSentinelPresence([Buffer.from(`snapshot:${sentinels[0]}`)], sentinels),
    ).toBeTrue()
    expect(
      acceptance.observeCredentialSentinelPresence([Buffer.from(`snapshot:${sentinels[1]}`)], sentinels),
    ).toBeTrue()
  })

  test("seeds the inert account against the exact pinned current-beta account schema", async () => {
    const accountSource = await readFile(new URL("../../opencode/src/account/account.sql.ts", import.meta.url), "utf8")
    const accountTable = accountSource.slice(
      accountSource.indexOf("export const AccountTable"),
      accountSource.indexOf("export const AccountStateTable"),
    )
    expect(accountTable).not.toContain("selected_org_id")
    expect(accountSource).toContain("active_org_id: text().$type<OrgID>()")

    const source = await readFile(new URL("./lean-upgrade-acceptance.mjs", import.meta.url), "utf8")
    expect(source).not.toContain("selected_org_id")
    expect(source).toContain("active_account_id, active_org_id")

    const database = new Database(":memory:")
    try {
      database.run(
        "CREATE TABLE account (id text PRIMARY KEY, email text NOT NULL, url text NOT NULL, access_token text NOT NULL, refresh_token text NOT NULL, token_expiry integer, time_created integer NOT NULL, time_updated integer NOT NULL)",
      )
      database.run(
        "CREATE TABLE account_state (id integer PRIMARY KEY NOT NULL, active_account_id text, active_org_id text)",
      )
      acceptance.seedLegacyAccount(database)
      expect(acceptance.legacyAccountIntact(database)).toBeTrue()
      expect(database.query("SELECT id, active_account_id, active_org_id FROM account_state").get()).toEqual({
        id: 1,
        active_account_id: "acc_upgrade_acceptance",
        active_org_id: null,
      })
      database.query("UPDATE account_state SET active_org_id = 'org_hostile'").run()
      expect(acceptance.legacyAccountIntact(database)).toBeFalse()
      database.query("UPDATE account_state SET active_org_id = NULL").run()
      database.query("UPDATE account SET access_token = 'substituted'").run()
      expect(acceptance.legacyAccountIntact(database)).toBeFalse()
    } finally {
      database.close()
    }
  })

  test("requires executed share/unshare refusal and complete nonempty network captures", () => {
    const event = {
      source: { id: 1, start_time: "1" },
      type: 1,
      phase: 0,
      time: "2",
      params: { url: "https://bharatcode.ai/api/model/v1/models" },
    }
    expect(
      acceptance.validatePackagedNetLogBytes(
        Buffer.from(JSON.stringify({ constants: { logEventTypes: {} }, events: [event] })),
      ),
    ).toBeTrue()
    for (const hostile of [
      Buffer.alloc(0),
      Buffer.from("{"),
      Buffer.from("{}"),
      Buffer.from(JSON.stringify({ constants: {}, events: [] })),
      Buffer.from(
        JSON.stringify({ constants: {}, events: [{ ...event, params: { url: "https://bharatcode.ai/api/share" } }] }),
      ),
    ]) {
      expect(() => acceptance.validatePackagedNetLogBytes(hostile)).toThrow()
    }

    const sidecarOrigin = "http://127.0.0.1:43123"
    const response = {
      status: 500,
      content_type: "application/json",
      body: '{"_tag":"InternalServerError"}',
      url: `${sidecarOrigin}/session/${session.id}/share`,
      redirected: false,
    }
    const observation = {
      schema: "bharatcode-live-electron-share-observation-v1",
      renderer_origin: "oc://renderer",
      sidecar_origin: sidecarOrigin,
      target_id: "renderer-page",
      root_pid: 4100,
      utility_pid: 4101,
      before_pids: [4100, 4101],
      after_pids: [4100, 4101],
      unauthenticated_control: {
        status: 401,
        content_type: null,
        body: "",
        url: `${sidecarOrigin}/session/${session.id}/share`,
        redirected: false,
        www_authenticate: 'Basic realm="Secure Area"',
      },
      post: response,
      delete: response,
      audit_requests: 0,
    }
    expect(acceptance.validateShareSurfaceObservation(observation)).toEqual({
      sharenextAbsent: true,
      shareNetworkAttemptAbsent: true,
    })
    for (const hostile of [
      { help_only: true },
      { ...observation, renderer_origin: "https://hostile.example" },
      { ...observation, unauthenticated_control: { ...observation.unauthenticated_control, status: 500 } },
      {
        ...observation,
        unauthenticated_control: { ...observation.unauthenticated_control, www_authenticate: null },
      },
      { ...observation, post: { ...response, status: 200 } },
      { ...observation, post: { ...response, status: 401 } },
      { ...observation, delete: { ...response, status: 401 } },
      { ...observation, post: { ...response, redirected: true } },
      { ...observation, audit_requests: 1 },
      { ...observation, after_pids: [4100] },
      { ...observation, utility_pid: 4199 },
    ]) {
      expect(() => acceptance.validateShareSurfaceObservation(hostile)).toThrow()
    }

    const target = {
      id: "renderer-page",
      type: "page",
      url: "oc://renderer/index.html",
      webSocketDebuggerUrl: "ws://127.0.0.1:43124/devtools/page/renderer-page",
    }
    expect(acceptance.selectRendererCdpTarget([target], 43124)).toEqual(target)
    for (const hostile of [
      [],
      [target, { ...target, id: "duplicate", webSocketDebuggerUrl: "ws://127.0.0.1:43124/devtools/page/duplicate" }],
      [{ ...target, url: "https://hostile.example" }],
      [{ ...target, webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/renderer-page" }],
    ]) {
      expect(() => acceptance.selectRendererCdpTarget(hostile, 43124)).toThrow()
    }

    const cdp = { id: 7, result: { result: { type: "object", value: observation } } }
    expect(acceptance.parseRendererShareEvaluation(cdp, 7)).toEqual(observation)
    for (const hostile of [
      { ...cdp, id: 8 },
      { id: 7, result: { exceptionDetails: { text: "fetch failed" } } },
      { id: 7, error: { message: "CDP disconnected" } },
    ]) {
      expect(() => acceptance.parseRendererShareEvaluation(hostile, 7)).toThrow()
    }

    const listeners = [
      { local_address: "127.0.0.1", local_port: 43124, state: "Listen", owning_process: 4100 },
      { local_address: "127.0.0.1", local_port: 43123, state: "Listen", owning_process: 4101 },
    ]
    expect(acceptance.validateLoopbackListenerOwner(listeners, { port: 43124, pid: 4100 })).toBeTrue()
    expect(acceptance.validateLoopbackListenerOwner(listeners, { port: 43123, pid: 4101 })).toBeTrue()
    for (const [hostile, expected] of [
      [
        listeners.map((item) => (item.local_port === 43124 ? { ...item, owning_process: 4999 } : item)),
        { port: 43124, pid: 4100 },
      ],
      [listeners.filter((item) => item.local_port !== 43123), { port: 43123, pid: 4101 }],
      [[...listeners, listeners[0]], { port: 43124, pid: 4100 }],
      [
        listeners.map((item) => (item.local_port === 43124 ? { ...item, local_address: "0.0.0.0" } : item)),
        { port: 43124, pid: 4100 },
      ],
    ]) {
      expect(() => acceptance.validateLoopbackListenerOwner(hostile, expected)).toThrow()
    }
  })

  test("accepts only the exact optional Chromium private-network preflight contract", async () => {
    const controlUrl = "http://10.20.30.40:43125/bharatcode-firewall-control"
    const harness = acceptance.routeEgressControlRequest(new Request(controlUrl), controlUrl)
    expect(harness.kind).toBe("harness-get")
    expect(harness.response.status).toBe(204)
    expect(Object.fromEntries(harness.response.headers)).toEqual({
      "cache-control": "no-store",
      connection: "close",
      "x-bharatcode-egress-control": "active",
    })
    expect(await harness.response.text()).toBe("")

    const preflight = acceptance.routeEgressControlRequest(
      new Request(controlUrl, {
        method: "OPTIONS",
        headers: {
          Origin: "oc://renderer",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Private-Network": "true",
        },
      }),
      controlUrl,
    )
    expect(preflight.kind).toBe("renderer-preflight")
    expect(preflight.response.status).toBe(204)
    expect(Object.fromEntries(preflight.response.headers)).toEqual({
      "access-control-allow-methods": "GET",
      "access-control-allow-origin": "oc://renderer",
      "access-control-allow-private-network": "true",
      "access-control-max-age": "0",
      "cache-control": "no-store",
      connection: "close",
    })
    expect(await preflight.response.text()).toBe("")

    const renderer = acceptance.routeEgressControlRequest(
      new Request(controlUrl, { headers: { Origin: "oc://renderer" } }),
      controlUrl,
    )
    expect(renderer.kind).toBe("renderer-get")
    expect(renderer.response.status).toBe(204)
    expect(Object.fromEntries(renderer.response.headers)).toEqual({
      "access-control-expose-headers": "Cache-Control, X-BharatCode-Egress-Control",
      "access-control-allow-origin": "oc://renderer",
      "cache-control": "no-store",
      connection: "close",
      "x-bharatcode-egress-control": "active",
    })
    expect(await renderer.response.text()).toBe("")

    for (const hostile of [
      new Request(controlUrl, {
        method: "OPTIONS",
        headers: {
          Origin: "https://hostile.example",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Private-Network": "true",
        },
      }),
      new Request(controlUrl, {
        method: "OPTIONS",
        headers: { Origin: "oc://renderer", "Access-Control-Request-Method": "GET" },
      }),
      new Request(controlUrl, {
        method: "OPTIONS",
        headers: {
          Origin: "oc://renderer",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Private-Network": "false",
        },
      }),
      new Request(controlUrl, {
        method: "OPTIONS",
        headers: {
          Origin: "oc://renderer",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Private-Network": "true",
        },
      }),
      new Request(controlUrl, { headers: { Origin: "https://hostile.example" } }),
      new Request(controlUrl, { method: "POST", headers: { Origin: "oc://renderer" } }),
      new Request(`${controlUrl}/foreign`, { headers: { Origin: "oc://renderer" } }),
    ]) {
      expect(() => acceptance.routeEgressControlRequest(hostile, controlUrl)).toThrow()
    }
  })

  test("requires enabled active firewall profiles and effective candidate-process egress blocking", () => {
    const firewall = {
      schema: "bharatcode-windows-firewall-observation-v1",
      active_profiles: ["Public"],
      control_address: "10.20.30.40",
      profiles: [
        { name: "Domain", enabled: true },
        { name: "Private", enabled: true },
        { name: "Public", enabled: true },
      ],
    }
    expect(acceptance.validateFirewallProfileObservation(firewall)).toEqual(firewall)
    for (const hostile of [
      { ...firewall, active_profiles: [] },
      { ...firewall, active_profiles: ["Public", "Public"] },
      { ...firewall, control_address: "127.0.0.1" },
      {
        ...firewall,
        profiles: firewall.profiles.map((profile) =>
          profile.name === "Public" ? { ...profile, enabled: false } : profile,
        ),
      },
    ]) {
      expect(() => acceptance.validateFirewallProfileObservation(hostile)).toThrow()
    }

    const egress = {
      schema: "bharatcode-candidate-egress-control-v1",
      renderer_origin: "oc://renderer",
      control_url: "http://10.20.30.40:43125/bharatcode-firewall-control",
      reachable_control: {
        status: 204,
        body: "",
        url: "http://10.20.30.40:43125/bharatcode-firewall-control",
        redirected: false,
        cache_control: "no-store",
        control_header: "active",
      },
      post_boundary_control: {
        status: 204,
        body: "",
        url: "http://10.20.30.40:43125/bharatcode-firewall-control",
        redirected: false,
        cache_control: "no-store",
        connection: "close",
        control_header: "active",
      },
      request_failed: true,
      preflight_observed: false,
      request_sequence_before: ["harness-get", "renderer-get"],
      request_sequence_blocked: ["harness-get", "renderer-get"],
      request_sequence_after: ["harness-get", "renderer-get", "harness-get"],
      requests_before: 2,
      requests_blocked: 2,
      requests_after: 3,
    }
    expect(acceptance.validateBlockedEgressObservation(egress, firewall)).toBeTrue()
    expect(
      acceptance.validateBlockedEgressObservation(
        {
          ...egress,
          preflight_observed: true,
          request_sequence_before: ["harness-get", "renderer-preflight", "renderer-get"],
          request_sequence_blocked: ["harness-get", "renderer-preflight", "renderer-get"],
          request_sequence_after: ["harness-get", "renderer-preflight", "renderer-get", "harness-get"],
          requests_before: 3,
          requests_blocked: 3,
          requests_after: 4,
        },
        firewall,
      ),
    ).toBeTrue()
    for (const hostile of [
      { ...egress, renderer_origin: "https://hostile.example" },
      { ...egress, control_url: "http://127.0.0.1:43125/bharatcode-firewall-control" },
      { ...egress, control_url: "http://10.20.30.40:99999/bharatcode-firewall-control" },
      { ...egress, reachable_control: { ...egress.reachable_control, status: 0 } },
      { ...egress, reachable_control: { ...egress.reachable_control, control_header: null } },
      { ...egress, reachable_control: { ...egress.reachable_control, cache_control: null } },
      { ...egress, post_boundary_control: { ...egress.post_boundary_control, status: 0 } },
      { ...egress, post_boundary_control: { ...egress.post_boundary_control, connection: "keep-alive" } },
      { ...egress, preflight_observed: true },
      { ...egress, request_sequence_before: ["harness-get", "renderer-get", "renderer-get"] },
      {
        ...egress,
        request_sequence_blocked: ["harness-get", "renderer-get", "renderer-preflight"],
        request_sequence_after: ["harness-get", "renderer-get", "renderer-preflight", "harness-get"],
        requests_blocked: 3,
        requests_after: 4,
      },
      { ...egress, request_sequence_after: ["harness-get", "renderer-get"], requests_after: 2 },
      { ...egress, requests_before: 1, requests_blocked: 1, requests_after: 2 },
      { ...egress, request_failed: false },
      { ...egress, requests_after: 4 },
    ]) {
      expect(() => acceptance.validateBlockedEgressObservation(hostile, firewall)).toThrow()
    }
  })

  test("always attempts every cleanup and preserves the original failure without leaking cleanup details", async () => {
    const calls: string[] = []
    const original = new Error("post-create validation failed")
    try {
      await acceptance.runAcceptanceWithCleanup(
        async () => {
          throw original
        },
        {
          processes: async () => {
            calls.push("processes")
            throw new Error("process-cleanup-sensitive-detail")
          },
          boundary: async () => {
            calls.push("boundary")
            throw new Error("firewall-removal-sensitive-detail")
          },
          audit: async () => {
            calls.push("audit")
            return true
          },
          egress: async () => {
            calls.push("egress")
            return true
          },
        },
      )
      throw new Error("cleanup failure was accepted")
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors[0]).toBe(original)
      expect((error as Error).message).toBe("Packaged upgrade acceptance failed; cleanup failed: processes,boundary")
      expect((error as Error).message).not.toMatch(/sensitive-detail/u)
    }
    expect(calls).toEqual(["processes", "boundary", "audit", "egress"])

    await expect(
      acceptance.runAcceptanceWithCleanup(async () => "result", {
        processes: async () => true,
        boundary: async () => false,
        audit: async () => true,
        egress: async () => true,
      }),
    ).rejects.toThrow("cleanup failed: boundary")
  })

  test("closes the public release, tag source, and selected asset API identity", async () => {
    const beta = await currentBeta()
    const asset = beta.assets[0]
    const value = {
      release: {
        id: Number(beta.release_id),
        tag_name: beta.tag,
        url: `https://api.github.com/repos/${beta.repository}/releases/${beta.release_id}`,
        assets_url: `https://api.github.com/repos/${beta.repository}/releases/${beta.release_id}/assets`,
        assets: [
          {
            id: Number(asset.asset_id),
            name: asset.filename,
            size: asset.bytes,
            digest: `sha256:${asset.sha256}`,
            url: `https://api.github.com/repos/${beta.repository}/releases/assets/${asset.asset_id}`,
          },
        ],
      },
      tag_commit_sha: beta.source_sha,
      asset: {
        id: Number(asset.asset_id),
        name: asset.filename,
        size: asset.bytes,
        digest: `sha256:${asset.sha256}`,
        url: `https://api.github.com/repos/${beta.repository}/releases/assets/${asset.asset_id}`,
      },
    }
    expect(validateCurrentBetaApiObservation(value, beta)).toEqual(value)
    for (const hostile of [
      { ...value, tag_commit_sha: "0".repeat(40) },
      { ...value, release: { ...value.release, id: 1 } },
      { ...value, release: { ...value.release, assets: [...value.release.assets, value.release.assets[0]] } },
      { ...value, asset: { ...value.asset, id: 1 } },
      { ...value, asset: { ...value.asset, size: asset.bytes - 1 } },
      { ...value, asset: { ...value.asset, digest: `sha256:${"b".repeat(64)}` } },
    ]) {
      expect(() => validateCurrentBetaApiObservation(hostile, beta)).toThrow()
    }
  })

  test("rejects a candidate installer substituted after its pinned observation", async () => {
    const root = await mkdtemp(join(tmpdir(), "lean-upgrade-installer-"))
    const path = join(root, candidate.filename)
    const bytes = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(16), Buffer.from("PE\0\0"), Buffer.alloc(16)])
    const expected = {
      ...candidate,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }
    try {
      await writeFile(path, bytes)
      expect(await verifyPinnedInstaller(path, expected)).toEqual(expected)
      await writeFile(path, Buffer.concat([bytes, Buffer.from("substituted")]))
      await expect(verifyPinnedInstaller(path, expected)).rejects.toThrow(/byte|SHA|changed|identity/i)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects incomplete checks, ShareNext/network attempts, cleanup drift, and secret leakage", () => {
    expect(validateUpgradeExecutionObservation(observation())).toEqual(observation())
    const missing = observation() as { checks: Record<string, boolean> }
    delete missing.checks.rollback_installed
    for (const hostile of [
      missing,
      { ...observation(), checks: { ...checks(), candidate_started: false } },
      { ...observation(), checks: { ...checks(), sharenext_absent: false } },
      { ...observation(), checks: { ...checks(), share_network_attempt_absent: false } },
      { ...observation(), cleanup_complete: false },
      { ...observation(), bearer_token: "secret-value" },
    ]) {
      expect(() => validateUpgradeExecutionObservation(hostile)).toThrow()
    }
  })

  test("fails before effects for fixture substitution and pre-existing acceptance output", async () => {
    const substituted = await fixture()
    try {
      const changed = await currentBeta()
      changed.assets[0].bytes -= 1
      await writeFile(substituted.localFixture, canonicalLeanJson(changed))
      let effects = 0
      await expect(
        runLeanUpgradeAcceptance(substituted.argv, {
          ...substituted.dependencies,
          execute: async () => {
            effects += 1
            return observation()
          },
        }),
      ).rejects.toThrow(/beta|asset|identity/i)
      expect(effects).toBe(0)
    } finally {
      await rm(substituted.root, { recursive: true, force: true })
    }

    const preexisting = await fixture()
    try {
      await mkdir(preexisting.acceptanceDirectory)
      await writeFile(join(preexisting.acceptanceDirectory, "upgrade-rollback-windows-x64.json"), "hostile")
      await expect(runLeanUpgradeAcceptance(preexisting.argv, preexisting.dependencies)).rejects.toThrow(
        /create-only|already exists/i,
      )
    } finally {
      await rm(preexisting.root, { recursive: true, force: true })
    }
  })

  test("rejects non-Windows, non-x64, process timeout/failure, and rollback failure without a receipt", async () => {
    for (const hostile of [
      { platform: "linux" },
      { arch: "arm64" },
      { execute: async () => Promise.reject(new Error("candidate startup timed out")) },
      { execute: async () => Promise.reject(new Error("installer process failed")) },
      { execute: async () => Promise.reject(new Error("rollback failed")) },
    ]) {
      const input = await fixture(hostile)
      try {
        await expect(runLeanUpgradeAcceptance(input.argv, input.dependencies)).rejects.toThrow()
        expect(await Bun.file(join(input.acceptanceDirectory, "upgrade-rollback-windows-x64.json")).exists()).toBe(
          false,
        )
      } finally {
        await rm(input.root, { recursive: true, force: true })
      }
    }
  })

  test("keeps a complete synthetic adapter diagnostic and structurally unable to emit PASS", async () => {
    const input = await fixture()
    try {
      const result = await runLeanUpgradeAcceptance(input.argv, input.dependencies)
      expect(result).toEqual({ authority: "DIAGNOSTIC", receiptPath: undefined })
      expect(await Bun.file(join(input.acceptanceDirectory, "upgrade-rollback-windows-x64.json")).exists()).toBe(false)
    } finally {
      await rm(input.root, { recursive: true, force: true })
    }
  })

  test("ships explicit real installer, process, timeout, cleanup, state, recovery, and network boundaries", async () => {
    const source = await readFile(new URL("./lean-upgrade-acceptance.mjs", import.meta.url), "utf8")
    for (const required of [
      "RUNNER_ENVIRONMENT",
      "fetch(",
      'open(path, "wx"',
      "Bun.spawn(",
      '"/S"',
      '"taskkill"',
      "PROCESS_TIMEOUT_MS",
      "productNameForChannel",
      "recovery",
      "status",
      "choose-source",
      "--content-fingerprint",
      "--confirm",
      "--json",
      '"models", "opencode"',
      "BharatCode ships only the BharatCode provider",
      "candidate did not replace the beta installation",
      "rollback did not restore the exact beta installation",
      "directoryIdentity",
      "Acceptance process timed out",
      "log-net-log",
      "betaStart.netLog",
      "candidateStart.netLog",
      "rollbackStart.netLog",
      "seedLegacyBetaState",
      "observeCandidateState",
      "observeRollbackState",
      "validateStateEvidence",
      "verifyRecoveryEvidence",
      "lean-migration-v1.json",
      "migration-snapshots",
      "INSERT INTO account (",
      "ACCEPTANCE_ACCESS_SENTINEL",
      "ACCEPTANCE_REFRESH_SENTINEL",
      "legacyAccountIntact",
      "observeCredentialStoreUsability",
      "observeCredentialSentinelPresence",
      "control_account",
      "validateShareSurfaceObservation",
      "validateUnauthenticatedSidecarResponse",
      "selectRendererCdpTarget",
      "parseRendererShareEvaluation",
      "validateLoopbackListenerOwner",
      "Get-NetTCPConnection -State Listen",
      "remote-debugging-port",
      "BHARATCODE_SHARE_ACCESS_TOKEN",
      "New-NetFirewallRule",
      "0.0.0.0-126.255.255.255",
      "128.0.0.0-255.255.255.255",
      "::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "Remove-NetFirewallRule",
      "validateFirewallProfileObservation",
      "validateBlockedEgressObservation",
      "runAcceptanceWithCleanup",
      "validatePackagedNetLogBytes",
      "Get-CimInstance Win32_Process",
      "initializeIsolatedProfile",
      "parseLeanUpgradeReceiptBytes",
    ]) {
      expect(source).toContain(required)
    }
    expect(source).not.toMatch(/extract|mock.*PASS|force.*PASS|app starting|recovery", "start-fresh/iu)
    expect(source).not.toContain("SELECT COUNT(*) AS count FROM account")
    expect(source).not.toContain('[runtime, "serve"')
    expect(source).not.toContain("BHARATCODE_SERVER_PASSWORD")
    expect(source).not.toContain("Authorization")
    expect(source).not.toMatch(/["']authorization["']\s*:/iu)
    expect(source).toContain('Basic realm="Secure Area"')
    expect(source).not.toContain("RemoteAddress Internet")
    const betaStart = source.indexOf('profile, "current-beta", active')
    const candidateInstall = source.indexOf("runInstaller(input.candidate")
    const recovery = source.indexOf("completeCandidateRecovery(candidateRuntime, profile)")
    const candidateStart = source.indexOf("const candidateStart = await startDesktop(")
    const liveShareProbe = source.indexOf("observeShareSurface(profile, candidateStart")
    const candidateCleanup = source.indexOf('finishDesktop(candidateStart, active, profile, "candidate")')
    const shareObserver = source.indexOf("async function observeShareSurface(")
    const rendererControl = source.indexOf("evaluateRendererEgressControl(", shareObserver)
    const networkBoundary = source.indexOf("installCandidateNetworkBoundary(desktop.executable", shareObserver)
    const blockedRendererControl = source.indexOf("evaluateRendererShareRequests(", shareObserver)
    const networkBoundaryCleanup = source.indexOf(
      "removeCandidateNetworkBoundary(candidateInstalled.application.executable",
    )
    expect(betaStart).toBeGreaterThan(-1)
    expect(candidateInstall).toBeGreaterThan(betaStart)
    expect(recovery).toBeGreaterThan(candidateInstall)
    expect(candidateStart).toBeGreaterThan(recovery)
    expect(liveShareProbe).toBeGreaterThan(candidateStart)
    expect(candidateCleanup).toBeGreaterThan(liveShareProbe)
    expect(rendererControl).toBeGreaterThan(shareObserver)
    expect(networkBoundary).toBeGreaterThan(rendererControl)
    expect(blockedRendererControl).toBeGreaterThan(networkBoundary)
    expect(networkBoundaryCleanup).toBeGreaterThan(candidateCleanup)
    expect(basename(fixturePath)).toBe("current-beta-windows-x64.json")
  })
})
