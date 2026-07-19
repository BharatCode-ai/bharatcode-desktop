import { Effect } from "effect"
import open from "open"

import { BharatCodeAccount } from "@/bharatcode/account"
import { BharatCodeLoopback } from "@/bharatcode/loopback"
import { cmd } from "./cmd"
import { CliError, effectCmd, fail } from "../effect-cmd"
import * as Prompt from "../effect/prompt"
import { UI } from "../ui"

export const localLogoutMessage = "Signed out locally. Existing access tokens may remain valid until they expire."

export function formatAccountStatus(status: BharatCodeAccount.Status): string[] {
  if (status.state === "signed-out") {
    return ["Signed out of BharatCode.", "Run `bharatcode auth login` to sign in."]
  }
  if (status.state === "sign-in-required") {
    return ["Your BharatCode session needs attention.", "Run `bharatcode auth login` to sign in again."]
  }
  if (status.state === "connection-problem") {
    return [
      "BharatCode could not verify your account right now.",
      "Your saved session was kept. Run `bharatcode auth reconnect` to try again.",
    ]
  }

  return ["Signed in to BharatCode.", status.name, status.email].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  )
}

const asCliError = (error: { message: string }) => new CliError({ message: error.message })

const openBrowser = (url: string) => Effect.promise(() => open(url).catch(() => undefined))

const printStatus = (status: BharatCodeAccount.Status) =>
  Effect.sync(() => {
    for (const line of formatAccountStatus(status)) UI.println(line)
  })

const login = Effect.fn("Cli.account.loginFlow")(function* (selectAccount: boolean) {
  const account = yield* BharatCodeAccount.Service
  const authorization = yield* account
    .beginAuthorization({
      redirectUri: BharatCodeAccount.CLI_REDIRECT_URI,
      selectAccount,
    })
    .pipe(Effect.mapError(asCliError))

  const session = yield* Effect.tryPromise({
    try: () => BharatCodeLoopback.start({ expectedState: authorization.state }),
    catch: (error) =>
      new CliError({
        message: error instanceof Error ? error.message : "BharatCode could not start sign-in.",
      }),
  }).pipe(Effect.tapError(() => account.cancelAuthorization(authorization.state)))

  yield* Prompt.intro(selectAccount ? "Use another BharatCode account" : "Sign in to BharatCode")
  yield* Prompt.log.info("Open this URL to continue: " + authorization.url)
  yield* openBrowser(authorization.url)

  const spinner = Prompt.spinner()
  yield* spinner.start("Waiting for BharatCode authorization...")

  const identity = yield* Effect.gen(function* () {
    const callbackUrl = yield* Effect.tryPromise({
      try: () => session.callback,
      catch: (error) =>
        new CliError({
          message: error instanceof Error ? error.message : "BharatCode sign-in did not complete.",
        }),
    })
    return yield* account.completeAuthorization(callbackUrl).pipe(Effect.mapError(asCliError))
  }).pipe(
    Effect.ensuring(
      Effect.all([Effect.sync(session.close), account.cancelAuthorization(authorization.state)]).pipe(Effect.asVoid),
    ),
    Effect.tapError(() => spinner.stop("BharatCode sign-in failed", 1)),
  )

  yield* spinner.stop(identity.email ? `Signed in as ${identity.email}` : "Signed in to BharatCode")
  yield* Prompt.outro("Done")
})

export const LoginCommand = effectCmd({
  command: "login",
  describe: "sign in to BharatCode",
  instance: false,
  builder: (yargs) =>
    yargs.option("switch-account", {
      describe: "ask BharatCode to show an account chooser",
      type: "boolean",
      default: false,
    }),
  handler: Effect.fn("Cli.account.login")(function* (args) {
    UI.empty()
    yield* login(args.switchAccount)
  }),
})

export const StatusCommand = effectCmd({
  command: "status",
  describe: "show safe BharatCode account status",
  instance: false,
  handler: Effect.fn("Cli.account.status")(function* () {
    const account = yield* BharatCodeAccount.Service
    const status = yield* account.status().pipe(Effect.mapError(asCliError))
    UI.empty()
    yield* printStatus(status)
  }),
})

export const LogoutCommand = effectCmd({
  command: "logout",
  describe: "remove the BharatCode session from this device",
  instance: false,
  handler: Effect.fn("Cli.account.logout")(function* () {
    const account = yield* BharatCodeAccount.Service
    yield* account.logout().pipe(Effect.mapError(asCliError))
    UI.empty()
    yield* Prompt.outro(localLogoutMessage)
  }),
})

export const ReconnectCommand = effectCmd({
  command: "reconnect",
  describe: "retry the saved BharatCode session",
  instance: false,
  handler: Effect.fn("Cli.account.reconnect")(function* () {
    const account = yield* BharatCodeAccount.Service
    const result = yield* account.accessToken({ forceRefresh: true }).pipe(
      Effect.as(true as const),
      Effect.catchTags({
        BharatCodeSignInRequired: () => Effect.succeed(false as const),
        BharatCodeTransportError: () => fail("BharatCode is unreachable right now. Your saved session was kept."),
        BharatCodeServiceError: (error) =>
          fail(error.retriable ? "BharatCode is temporarily unavailable. Your saved session was kept." : error.message),
        BharatCodeOAuthError: (error) => fail(error.message),
        AuthError: (error) => fail(error.message),
      }),
    )
    if (!result) return yield* fail("Your BharatCode session is no longer valid. Run `bharatcode auth login`.")
    const status = yield* account.status().pipe(Effect.mapError(asCliError))
    UI.empty()
    yield* printStatus(status)
  }),
})

export const AccountCommand = cmd({
  command: "auth",
  aliases: ["account"],
  describe: "manage your BharatCode account",
  builder: (yargs) =>
    yargs.command(LoginCommand).command(StatusCommand).command(LogoutCommand).command(ReconnectCommand).demandCommand(),
  async handler() {},
})
