import { SessionV2 } from "@/v2/session"
import { Layer } from "effect"
import { layer as v2LocationLayer } from "../groups/v2/location"
import { messageHandlers } from "./v2/message"
import { modelHandlers } from "./v2/model"
import { providerHandlers } from "./v2/provider"
import { sessionHandlers } from "./v2/session"
import { accountHandlers } from "./v2/account"

export const v2Handlers = Layer.mergeAll(
  accountHandlers,
  sessionHandlers,
  messageHandlers,
  modelHandlers,
  providerHandlers,
).pipe(Layer.provide(v2LocationLayer), Layer.provide(SessionV2.defaultLayer))
