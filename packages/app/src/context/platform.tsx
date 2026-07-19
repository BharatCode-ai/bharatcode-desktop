import { createSimpleContext } from "@opencode-ai/ui/context"
import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Accessor } from "solid-js"
import type { DesktopMenuAction } from "../desktop-menu"
import { ServerConnection } from "./server"

type PickerPaths = string | string[] | null
type OpenDirectoryPickerOptions = { title?: string; multiple?: boolean }
type OpenFilePickerOptions = { title?: string; multiple?: boolean; accept?: string[]; extensions?: string[] }
type SaveFilePickerOptions = { title?: string; defaultPath?: string }
type UpdateInfo = { updateAvailable: boolean; version?: string }
type PlatformName = "web" | "desktop"
type DesktopOS = "macos" | "windows" | "linux"

export type DictationAudioInput = {
  buffer: ArrayBuffer
  mimeType: string
  filename: string
}

export type DictationTranscription = {
  text: string
  language?: string
  duration?: number
}

export type BharatCodeSignInOptions = {
  selectAccount?: boolean
}

export type BharatCodeAccountState =
  | "signed_out"
  | "signed_in"
  | "needs_sign_in"
  | "connection_issue"
  | "authorizing"
  | "refreshing"
  | "switching"

export type BharatCodeAccountStatus = {
  authenticated: boolean
  state: BharatCodeAccountState
  checkedAt: string
  email?: string
  name?: string
  expiresAt?: number
  message?: string
}

export type CapabilityTrust = "bundled" | "curated" | "local"
export type CapabilityStatus = "available" | "installed" | "enabled" | "needs_setup" | "unhealthy" | "update_available"
export type CapabilityCategory =
  | "workflow"
  | "code-hosting"
  | "browser"
  | "design"
  | "planning"
  | "monitoring"
  | "database"
  | "billing"
  | "docs"
export type CapabilityPermission =
  | "workspace_files"
  | "local_process"
  | "browser_automation"
  | "oauth_account"
  | "network"
  | "env_vars"
  | "background_process"
  | "billing_data"
  | "database_data"
  | "deployment_data"
  | "monitoring_data"

export type CapabilityMcpConfig =
  | {
      type: "remote"
      url: string
      enabled?: boolean
      headers?: Record<string, string>
      oauth?:
        | false
        | {
            clientId?: string
            clientSecret?: string
            scope?: string
            callbackPort?: number
            redirectUri?: string
          }
      timeout?: number
    }
  | {
      type: "local"
      command: string[]
      environment?: Record<string, string>
      enabled?: boolean
      timeout?: number
    }

export type CapabilityModule =
  | { type: "skill"; id: "superpowers"; path: "bundled-superpowers" }
  | { type: "mcp"; name: string; config: CapabilityMcpConfig }
  | { type: "connector"; name: string }
  | { type: "prompt"; name: string }
  | { type: "surface"; name: string }

export type CapabilityCatalogItem = {
  id: string
  name: string
  description: string
  publisher: string
  version: string
  category: CapabilityCategory
  trust: CapabilityTrust
  defaultEnabled?: boolean
  requiresSetup?: boolean
  requirements: string[]
  permissions: CapabilityPermission[]
  modules: CapabilityModule[]
}

export type CapabilityInstallRecord = {
  id: string
  version: string
  status: Exclude<CapabilityStatus, "available">
  enabled: boolean
  trust: CapabilityTrust
  installedAt: string
  updatedAt: string
  health?: {
    ok: boolean
    message?: string
    checkedAt: string
  }
}

export type CapabilityState = {
  version: 1
  installed: Record<string, CapabilityInstallRecord>
}

export type CapabilityRuntimeManifest = {
  skills: {
    paths: string[]
  }
  mcp: Record<string, CapabilityMcpConfig>
}

export type CapabilitySnapshot = {
  catalog: CapabilityCatalogItem[]
  state: CapabilityState
  runtime: CapabilityRuntimeManifest
}

export type FatalRendererErrorLog = {
  error: string
  url: string
  version?: string
  platform: PlatformName
  os?: DesktopOS
}

export type WslErrorCode =
  | "wsl-unavailable"
  | "no-wsl2-distribution"
  | "selection-required"
  | "selection-invalid"
  | "root-user"
  | "prerequisite-missing"
  | "runtime-integrity"
  | "path-translation"
  | "start-failed"
  | "connection-lost"
  | "stop-failed"

export type WslStatus = { phase: "off" | "ready" | "starting" | "running" } | { phase: "error"; code: WslErrorCode }

export type WslSnapshot = {
  enabled: boolean
  revision: number
  selectedDisplayName?: string
  distributions: Array<{ displayName: string; version: 2; selected: boolean }>
  status: WslStatus
}

export type WslConfigurationUpdate =
  | { enabled: false; expectedRevision: number }
  | { enabled: true; expectedRevision: number; selectedDisplayName: string }

export type Platform = {
  /** Platform discriminator */
  platform: PlatformName

  /** Desktop OS (Tauri only) */
  os?: DesktopOS

  /** App version */
  version?: string

  /** Open a URL in the default browser */
  openLink(url: string): void

  /** Open a local path in a local app (desktop only) */
  openPath?(path: string, app?: string): Promise<void>

  /** Restart the app  */
  restart(): Promise<void>

  /** Navigate back in history */
  back(): void

  /** Navigate forward in history */
  forward(): void

  /** Send a system notification (optional deep link) */
  notify(title: string, description?: string, href?: string): Promise<void>

  /** Open directory picker dialog (native on Tauri, server-backed on web) */
  openDirectoryPickerDialog?(opts?: OpenDirectoryPickerOptions): Promise<PickerPaths>

  /** Open native file picker dialog (Tauri only) */
  openFilePickerDialog?(opts?: OpenFilePickerOptions): Promise<PickerPaths>

  /** Save file picker dialog (Tauri only) */
  saveFilePickerDialog?(opts?: SaveFilePickerOptions): Promise<string | null>

  /** Storage mechanism, defaults to localStorage */
  storage?: (name?: string) => SyncStorage | AsyncStorage

  /** Check for a downloadable desktop update */
  checkUpdate?(): Promise<UpdateInfo>

  /** Install the downloaded update using the platform restart flow */
  updateAndRestart?(): Promise<void>

  /** Fetch override */
  fetch?: typeof fetch

  /** Get the configured default server URL (platform-specific) */
  getDefaultServer?(): Promise<ServerConnection.Key | null>

  /** Set the default server URL to use on app startup (platform-specific) */
  setDefaultServer?(url: ServerConnection.Key | null): Promise<void> | void

  /** Read the renderer-safe WSL integration status (Windows desktop only) */
  getWslSnapshot?(): Promise<WslSnapshot>

  /** Apply a revision-bound WSL selection update (Windows desktop only) */
  configureWsl?(update: WslConfigurationUpdate): Promise<WslSnapshot>

  /** Revalidate WSL prerequisites and selection (Windows desktop only) */
  retryWsl?(): Promise<WslSnapshot>

  /** Get the preferred display backend (desktop only) */
  getDisplayBackend?(): Promise<DisplayBackend | null> | DisplayBackend | null

  /** Set the preferred display backend (desktop only) */
  setDisplayBackend?(backend: DisplayBackend): Promise<void>

  /** Parse markdown to HTML using native parser (desktop only, returns unprocessed code blocks) */
  parseMarkdown?(markdown: string): Promise<string>

  /** Webview zoom level (desktop only) */
  webviewZoom?: Accessor<number>

  /** Get whether native pinch/Ctrl-scroll zoom gestures are enabled (desktop only) */
  getPinchZoomEnabled?(): Promise<boolean> | boolean

  /** Allow native pinch/Ctrl-scroll zoom gestures (desktop only) */
  setPinchZoomEnabled?(enabled: boolean): Promise<void> | void

  /** Run a desktop-only menu action from the app chrome */
  runDesktopMenuAction?(action: DesktopMenuAction): Promise<void> | void

  /** Check if an editor app exists (desktop only) */
  checkAppExists?(appName: string): Promise<boolean>

  /** Read image from clipboard (desktop only) */
  readClipboardImage?(): Promise<File | null>

  /** Transcribe recorded prompt audio (desktop only) */
  transcribeAudio?(audio: DictationAudioInput): Promise<DictationTranscription>

  /** Read safe BharatCode account/auth status without exposing tokens (desktop only) */
  getAccountStatus?(): Promise<BharatCodeAccountStatus>

  /** Refresh credentials if possible and check BharatCode connectivity (desktop only) */
  refreshAccountStatus?(): Promise<BharatCodeAccountStatus>

  /** Start BharatCode browser sign-in (desktop only) */
  beginSignIn?(options?: BharatCodeSignInOptions): Promise<BharatCodeAccountStatus>

  completeSignIn?(): Promise<BharatCodeAccountStatus>

  logout?(): Promise<BharatCodeAccountStatus>

  /** Read installed and available BharatCode capabilities (desktop only) */
  getCapabilitySnapshot?(): Promise<CapabilitySnapshot>

  /** Install a curated BharatCode capability (desktop only) */
  installCapability?(id: string): Promise<CapabilitySnapshot>

  /** Enable or disable an installed BharatCode capability (desktop only) */
  setCapabilityEnabled?(id: string, enabled: boolean): Promise<CapabilitySnapshot>

  /** Uninstall a curated BharatCode capability (desktop only) */
  uninstallCapability?(id: string): Promise<CapabilitySnapshot>

  /** Re-apply the BharatCode capability runtime manifest (desktop only) */
  applyCapabilityRuntime?(): Promise<CapabilitySnapshot>

  /** Export collected diagnostic logs (desktop only) */
  exportDebugLogs?(): Promise<string>

  /** Record a fatal renderer error in platform logs (desktop only) */
  recordFatalRendererError?(error: FatalRendererErrorLog): Promise<void>
}

export type DisplayBackend = "auto" | "wayland"

export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext({
  name: "Platform",
  init: (props: { value: Platform }) => {
    return props.value
  },
})
