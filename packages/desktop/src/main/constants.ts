import { app } from "electron"
import { normalizeChannel, type Channel } from "./branding"

const raw = import.meta.env.BHARATCODE_CHANNEL || import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = normalizeChannel(raw)

export const SETTINGS_STORE = "bharatcode.settings"
export const DEFAULT_SERVER_URL_KEY = "defaultServerUrl"
export const WSL_ENABLED_KEY = "wslEnabled"
export const PINCH_ZOOM_ENABLED_KEY = "pinchZoomEnabled"
export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev"
