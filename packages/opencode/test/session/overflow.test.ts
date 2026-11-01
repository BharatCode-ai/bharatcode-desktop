import { describe, expect, test } from "bun:test"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { isOverflow, threshold, usable } from "@/session/overflow"

// usable and isOverflow read only `limit`, and maxOutputTokens reads only `limit.output`, so the
// rest of the model record is irrelevant here.
const model = (limit: { context: number; output: number; input?: number }) =>
  ({ limit }) as unknown as Provider.Model

const config = (compaction?: { auto?: boolean; reserved?: number }) => ({ compaction }) as ConfigV1.Info

const tokens = (input: number, cacheRead = 0) =>
  ({ input, output: 0, reasoning: 0, cache: { read: cacheRead, write: 0 } }) as SessionV1.Assistant["tokens"]

describe("usable", () => {
  test("is zero when the context limit is unknown", () => {
    expect(usable({ cfg: config(), model: model({ context: 0, output: 4_000 }) })).toBe(0)
  })

  test("reserves at least the compaction buffer", () => {
    expect(usable({ cfg: config(), model: model({ context: 128_000, output: 8_000 }) })).toBe(108_000)
  })

  test("reserves the output allowance when it exceeds the buffer", () => {
    expect(usable({ cfg: config(), model: model({ context: 200_000, output: 32_000 }) })).toBe(168_000)
  })

  test("treats an input cap the same as a context window", () => {
    const capped = usable({ cfg: config(), model: model({ context: 400_000, input: 200_000, output: 32_000 }) })
    const uncapped = usable({ cfg: config(), model: model({ context: 200_000, output: 32_000 }) })
    expect(capped).toBe(uncapped)
  })

  test("honours a configured reserve on a model with no input cap", () => {
    expect(usable({ cfg: config({ reserved: 50_000 }), model: model({ context: 128_000, output: 8_000 }) })).toBe(
      78_000,
    )
  })

  test("honours a configured reserve on a model with an input cap", () => {
    expect(
      usable({ cfg: config({ reserved: 50_000 }), model: model({ context: 400_000, input: 200_000, output: 32_000 }) }),
    ).toBe(150_000)
  })

  test("a zero reserve gives the whole window", () => {
    expect(usable({ cfg: config({ reserved: 0 }), model: model({ context: 128_000, output: 8_000 }) })).toBe(128_000)
  })
})

describe("threshold", () => {
  // The two models BharatCode serves. Both publish a 32_000 max output and no input cap.
  const qwen = model({ context: 262_144, output: 32_000 })
  const deepseek = model({ context: 1_000_000, output: 32_000 })

  test("leaves headroom below what fits", () => {
    expect(usable({ cfg: config(), model: qwen })).toBe(230_144)
    expect(threshold({ cfg: config(), model: qwen })).toBe(214_144)
  })

  test("costs a large window almost nothing", () => {
    expect(usable({ cfg: config(), model: deepseek })).toBe(968_000)
    expect(threshold({ cfg: config(), model: deepseek })).toBe(952_000)
  })

  test("takes the same headroom regardless of window size", () => {
    expect(usable({ cfg: config(), model: qwen }) - threshold({ cfg: config(), model: qwen })).toBe(
      usable({ cfg: config(), model: deepseek }) - threshold({ cfg: config(), model: deepseek }),
    )
  })

  test("honours a configured reserve exactly, with nothing added on top", () => {
    const cfg = config({ reserved: 50_000 })
    expect(threshold({ cfg, model: qwen })).toBe(usable({ cfg, model: qwen }))
  })

  test("leaves a budget with nothing to spare alone", () => {
    // usable is 28_000 here; subtracting the headroom would compact on every turn forever.
    const cfg = config()
    const tiny = model({ context: 48_000, output: 8_000 })
    expect(usable({ cfg, model: tiny })).toBe(28_000)
    expect(threshold({ cfg, model: tiny })).toBe(28_000)
  })
})

describe("isOverflow", () => {
  const qwen = model({ context: 128_000, output: 8_000 })

  test("compacts once the reserve is eaten into", () => {
    expect(isOverflow({ cfg: config(), tokens: tokens(110_000), model: qwen })).toBe(true)
  })

  test("leaves room below the threshold alone", () => {
    expect(isOverflow({ cfg: config(), tokens: tokens(60_000), model: qwen })).toBe(false)
  })

  test("counts cached reads toward the total", () => {
    expect(isOverflow({ cfg: config(), tokens: tokens(10_000, 100_000), model: qwen })).toBe(true)
  })

  test("a configured reserve moves the trigger", () => {
    const cfg = config({ reserved: 50_000 })
    expect(isOverflow({ cfg, tokens: tokens(80_000), model: qwen })).toBe(true)
    expect(isOverflow({ cfg: config(), tokens: tokens(80_000), model: qwen })).toBe(false)
  })

  test("models with and without an input cap agree", () => {
    const capped = model({ context: 200_000, input: 200_000, output: 32_000 })
    const uncapped = model({ context: 200_000, output: 32_000 })
    const used = tokens(181_000)
    expect(isOverflow({ cfg: config(), tokens: used, model: capped })).toBe(
      isOverflow({ cfg: config(), tokens: used, model: uncapped }),
    )
  })

  test("honours auto: false", () => {
    expect(isOverflow({ cfg: config({ auto: false }), tokens: tokens(120_000), model: qwen })).toBe(false)
  })

  test("compacts in the headroom band, before the budget is spent", () => {
    const real = model({ context: 262_144, output: 32_000 })
    // Past the 214_144 threshold but still under the 230_144 that would actually fit — this band is
    // the behaviour change, and is where a large tool result used to tip the request over.
    expect(isOverflow({ cfg: config(), tokens: tokens(220_000), model: real })).toBe(true)
    expect(isOverflow({ cfg: config(), tokens: tokens(200_000), model: real })).toBe(false)
  })

  test("never fires when the context limit is unknown", () => {
    expect(isOverflow({ cfg: config(), tokens: tokens(500_000), model: model({ context: 0, output: 4_000 }) })).toBe(
      false,
    )
  })
})
