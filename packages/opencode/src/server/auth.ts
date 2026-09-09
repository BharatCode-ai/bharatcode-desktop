export * as ServerAuth from "./auth"

import { ConfigService } from "@/effect/config-service"
import { Config as EffectConfig, Context, Option, Redacted } from "effect"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export class Config extends ConfigService.Service<Config>()("@opencode/ServerAuthConfig", {
  password: EffectConfig.string("BHARATCODE_SERVER_PASSWORD").pipe(EffectConfig.option),
  username: EffectConfig.string("BHARATCODE_SERVER_USERNAME").pipe(EffectConfig.withDefault("bharatcode")),
}) {}

export type Info = Context.Service.Shape<typeof Config>

export function rejectLegacyEnvironment(environment: Record<string, string | undefined>) {
  if ("OPENCODE_SERVER_USERNAME" in environment || "OPENCODE_SERVER_PASSWORD" in environment) {
    throw new Error("Legacy server authentication variables are not supported; use BharatCode server credentials.")
  }
}

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  return (
    Option.isSome(config.password) &&
    credentials.username === config.username &&
    Redacted.value(credentials.password) === config.password.value
  )
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? process.env.BHARATCODE_SERVER_PASSWORD
  if (!password) return undefined

  const username = credentials?.username ?? process.env.BHARATCODE_SERVER_USERNAME ?? "bharatcode"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
