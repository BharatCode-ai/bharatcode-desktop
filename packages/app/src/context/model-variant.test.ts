import { describe, expect, test } from "bun:test"
import {
  cycleModelVariant,
  defaultPickerEffort,
  getConfiguredAgentVariant,
  pickerOptions,
  resolveModelVariant,
} from "./model-variant"

describe("model variant", () => {
  for (const id of ["glm-5.3-flash", "qwen-3.8-27b"]) {
    test(`offers Low and High with a Low default for BharatCode ${id}`, () => {
      const model = { provider: { id: "bharatcode" }, id }
      const variants = ["low", "high"]
      expect(pickerOptions(model, variants)).toEqual(["low", "high"])
      expect(defaultPickerEffort(model, variants)).toBe("low")
      expect(resolveModelVariant({ variants, selected: "high", configured: undefined })).toBe("high")
      expect(defaultPickerEffort(model, [])).toBeUndefined()
      expect(pickerOptions({ provider: { id: "other" }, id }, variants)).toEqual(["default", "low", "high"])
    })
  }

  test("resolves configured agent variant when model matches", () => {
    const value = getConfiguredAgentVariant({
      agent: {
        model: { providerID: "openai", modelID: "gpt-5.2" },
        variant: "xhigh",
      },
      model: {
        providerID: "openai",
        modelID: "gpt-5.2",
        variants: { low: {}, high: {}, xhigh: {} },
      },
    })

    expect(value).toBe("xhigh")
  })

  test("ignores configured variant when model does not match", () => {
    const value = getConfiguredAgentVariant({
      agent: {
        model: { providerID: "openai", modelID: "gpt-5.2" },
        variant: "xhigh",
      },
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
        variants: { low: {}, high: {}, xhigh: {} },
      },
    })

    expect(value).toBeUndefined()
  })

  test("prefers selected variant over configured variant", () => {
    const value = resolveModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: "high",
      configured: "xhigh",
    })

    expect(value).toBe("high")
  })

  test("lets an explicit default override the configured variant", () => {
    const value = resolveModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: null,
      configured: "xhigh",
    })

    expect(value).toBeUndefined()
  })

  test("cycles from configured variant to next", () => {
    const value = cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: undefined,
      configured: "high",
    })

    expect(value).toBe("xhigh")
  })

  test("wraps from configured last variant to first", () => {
    const value = cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: undefined,
      configured: "xhigh",
    })

    expect(value).toBe("low")
  })

  test("cycles from an explicit default to the first variant", () => {
    const value = cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: null,
      configured: "xhigh",
    })

    expect(value).toBe("low")
  })
})
