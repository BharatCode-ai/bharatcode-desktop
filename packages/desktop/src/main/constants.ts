import { app } from "electron"
import { normalizeChannel } from "./branding"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL = normalizeChannel(raw)

export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev"
