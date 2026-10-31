import { join } from "node:path"
import { mkdir, readFile, writeFile, rename } from "node:fs/promises"
import QRCode from "qrcode"
import { createGateway } from "./gateway.mjs"
import { connectTunnel, removeTunnel } from "./tunnel.mjs"
import { openDevices, resetDevices } from "./devices.mjs"
import { resetAdmissions } from "./admissions.mjs"

export async function createMobileAccess(options) {
  const root = join(options.userDataPath, "mobile-access")
  const storePath = join(root, "devices.json")
  let gateway,
    tunnel,
    pairing,
    qrImage,
    pairingExpiresAt,
    errorKey,
    starting,
    controller,
    epoch = 0
  let devices = [],
    requests = [],
    cancellations = 0
  let enabled = false,
    status = "off",
    progress
  const flagPath = join(root, "enabled.json")
  const persist = async (value) => {
    await mkdir(root, { recursive: true, mode: 0o700 })
    await writeFile(flagPath + ".tmp", JSON.stringify({ enabled: value }), { mode: 0o600 })
    await rename(flagPath + ".tmp", flagPath)
  }
  const snapshot = () => ({
    enabled,
    connecting: !!starting,
    status,
    progress,
    devices: (gateway ? gateway.devices() : devices).map((d) => ({ ...d })),
    requests: requests.filter((r) => r.expiresAt > Date.now()).map((r) => ({ ...r })),
    pairing: pairingExpiresAt > Date.now() ? pairing : undefined,
    qrImage: pairingExpiresAt > Date.now() ? qrImage : undefined,
    errorKey,
  })
  const emit = () => options.onChange?.(snapshot())
  // Optional mobile storage must never make Desktop's startup initializer fail.
  async function loadDevices() {
    try {
      devices = (await openDevices(storePath)).list()
    } catch (error) {
      errorKey = "mobile.error.storage"
      throw error
    }
  }
  async function enable() {
    if (enabled) return
    if (starting) return starting
    const token = ++epoch
    controller = new AbortController()
    status = "provisioning"
    errorKey = undefined
    progress = "creating-tunnel"
    emit()
    starting = (async () => {
      await loadDevices()
      controller.signal.throwIfAborted()
      const connection = options.getConnection()
      if (!connection?.password) throw new Error("Protected local Desktop sidecar required")
      gateway = await createGateway({
        runtime: "desktop",
        upstream: connection.url,
        username: connection.username ?? "opencode",
        password: connection.password,
        storePath,
        onPairingRequest: (claim) => {
          requests.push(claim)
          emit()
        },
      })
      try {
        controller.signal.throwIfAborted()
        const target = await gateway.listen()
        tunnel = await (options.tunnelFactory ?? connectTunnel)({
          target,
          storePath: join(root, "tunnel-bharatcode-ai"),
          signal: controller.signal,
          onProgress: (stage) => {
            if (token === epoch) {
              progress = stage
              emit()
            }
          },
        })
        if (token !== epoch) {
          await tunnel.close()
          tunnel = undefined
          return
        }
        enabled = true
        status = "connected"
        progress = undefined
        await persist(true)
        void (async () => {
          try {
            for await (const event of tunnel.events) {
              if (token !== epoch) break
              if (["disconnected", "reconnecting", "connecting"].includes(event.type)) {
                status = "reconnecting"
                errorKey = "mobile.error.reconnecting"
              } else if (event.type === "connected") {
                status = "connected"
                errorKey = undefined
              } else if (event.type === "stopped") {
                status = "error"
                errorKey = "mobile.error.connection"
              }
              emit()
            }
          } catch {
            if (token === epoch) {
              status = "error"
              errorKey = "mobile.error.connection"
              emit()
            }
          }
        })()
      } catch (error) {
        await gateway?.close()
        await tunnel?.close()
        gateway = undefined
        tunnel = undefined
        enabled = false
        throw error
      }
    })()
    try {
      await starting
    } catch (error) {
      if (token === epoch) {
        status = "error"
        errorKey ??= error.mobileStorage ? "mobile.error.storage" : "mobile.error.connection"
      }
      throw error
    } finally {
      starting = undefined
      emit()
    }
  }
  async function shutdown(disable) {
    ++epoch
    controller?.abort()
    if (starting) {
      try {
        await starting
      } catch {}
    }
    if (gateway) devices = gateway.devices()
    await gateway?.close()
    await tunnel?.close()
    gateway = undefined
    tunnel = undefined
    enabled = false
    status = "off"
    progress = undefined
    errorKey = undefined
    pairing = undefined
    qrImage = undefined
    pairingExpiresAt = undefined
    requests = []
    if (disable) await persist(false)
    emit()
  }
  async function run(input) {
    if (
      !input ||
      typeof input.type !== "string" ||
      (input.id !== undefined && (typeof input.id !== "string" || input.id.length > 100))
    )
      throw new Error("Invalid mobile action")
    if (input.type === "state") return snapshot()
    if (input.type === "pair") {
      if (status === "error" && enabled) await shutdown(false)
      await enable()
      if (!enabled || !gateway || !tunnel) return snapshot()
      const invitation = gateway.issuePairing(tunnel.origin)
      requests = []
      pairingExpiresAt = invitation.expiresAt
      pairing =
        "bharatcode://pair?" + new URLSearchParams({ origin: invitation.origin, desktopID: invitation.desktopID })
      qrImage = await QRCode.toDataURL(pairing, { width: 300, margin: 4, errorCorrectionLevel: "M" })
    } else if (input.type === "disable") {
      await shutdown(true)
    } else if (input.type === "reset") {
      await shutdown(true)
      try {
        await resetAdmissions(join(root, "admissions.json"))
        devices = (await resetDevices(storePath)).list()
      } catch (error) {
        status = "error"
        errorKey = "mobile.error.storage"
        emit()
        throw error
      }
      await (options.removeTunnel ?? removeTunnel)({ storePath: join(root, "tunnel-bharatcode-ai") })
    } else if (input.type === "approve") {
      if (!gateway) throw new Error("Remote access disabled")
      await gateway.approve(input.id)
      requests = []
      pairing = undefined
      qrImage = undefined
    } else if (input.type === "decline") {
      gateway?.decline(input.id)
      requests = requests.filter((r) => r.claimID !== input.id)
    } else if (input.type === "revoke") {
      if (gateway) await gateway.revoke(input.id)
      else {
        const registry = await openDevices(storePath)
        await registry.remove(input.id)
        devices = registry.list()
      }
    } else {
      throw new Error("Unknown mobile action")
    }
    if (gateway) devices = gateway.devices()
    emit()
    return snapshot()
  }
  let actions = Promise.resolve()
  return {
    snapshot,
    action(input) {
      // Status and cancellation must remain available during multi-minute issuance.
      if (input?.type === "state") return Promise.resolve(snapshot())
      if (input?.type === "disable" || input?.type === "reset") {
        cancellations++
        controller?.abort()
      }
      const generation = cancellations
      const operation = actions.then(() =>
        input?.type === "pair" && generation !== cancellations ? snapshot() : run(input),
      )
      actions = operation.catch(() => {})
      return operation
    },
    restore() {
      const generation = cancellations
      const operation = actions.then(async () => {
        if (generation !== cancellations) return
        try {
          await loadDevices()
          const preference = JSON.parse(await readFile(flagPath, "utf8"))
          if (generation !== cancellations) return
          if (preference.enabled === true) await enable()
        } catch (error) {
          if (error.code !== "ENOENT") {
            status = "error"
            errorKey ??= "mobile.error.storage"
            emit()
          }
        }
      })
      actions = operation.catch(() => {})
      return operation
    },
    async close() {
      cancellations++
      controller?.abort()
      await actions
      await shutdown(false)
    },
  }
}
