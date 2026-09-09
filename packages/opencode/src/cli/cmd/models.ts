import { EOL } from "node:os"
import { Effect } from "effect"

import { BharatCodeCatalog } from "@/bharatcode/catalog"
import { effectCmd, fail } from "../effect-cmd"

export function selectCodingModels(models: readonly BharatCodeCatalog.Model[]) {
  return models
    .filter((model) => BharatCodeCatalog.codingEligibility(model).eligible)
    .toSorted((a, b) => a.id.localeCompare(b.id))
}

function safeDetails(model: BharatCodeCatalog.Model) {
  return {
    id: model.id,
    display_name: model.displayName,
    modality: model.modality,
    protocol: model.protocol,
    endpoint: model.endpoint,
    context_window: model.contextWindow,
    max_output_tokens: model.maxOutputTokens,
    capabilities: {
      input: model.metadata.input,
      output: model.metadata.output,
      toolCalling: model.metadata.toolCalling === true,
      reasoning: model.metadata.reasoning === true,
    },
  }
}

export const ModelsCommand = effectCmd({
  command: "models [provider]",
  describe: "list available BharatCode coding models",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("provider", {
        describe: "must be bharatcode when provided",
        type: "string",
        array: false,
      })
      .option("verbose", {
        describe: "include the public serving contract and capabilities",
        type: "boolean",
      })
      .option("refresh", {
        describe: "refresh the authenticated BharatCode model catalog",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.models")(function* (args) {
    if (args.provider && args.provider !== "bharatcode") {
      return yield* fail(`Unsupported provider "${args.provider}". BharatCode ships only the BharatCode provider.`)
    }

    const catalog = yield* BharatCodeCatalog.Service
    const records = yield* catalog.list({ force: args.refresh }).pipe(
      Effect.catchTags({
        BharatCodeSignInRequired: () => fail("Sign in with `bharatcode auth login` to load models."),
        BharatCodeTransportError: () => fail("BharatCode is unreachable right now. Try again later."),
        BharatCodeServiceError: () => fail("The BharatCode model catalog is temporarily unavailable."),
        BharatCodeOAuthError: (error) => fail(error.message),
        BharatCodeCatalogError: (error) => fail(error.message),
        AuthError: (error) => fail(error.message),
      }),
    )
    const models = selectCodingModels(records)
    if (models.length === 0) return yield* fail("No eligible BharatCode coding models are currently available.")

    for (const model of models) {
      process.stdout.write(`bharatcode/${model.id}${EOL}`)
      if (args.verbose) process.stdout.write(JSON.stringify(safeDetails(model), null, 2) + EOL)
    }
  }),
})
