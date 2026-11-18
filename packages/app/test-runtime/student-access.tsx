import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { ModelRecovery } from "../src/components/model-recovery"
import { PlatformProvider, type Platform } from "../src/context/platform"
import { LanguageProvider } from "../src/context/language"
import { MODEL_ACCESS_REQUIRED } from "@opencode-ai/core/util/model-recovery"
import { Card } from "@opencode-ai/ui/card"
import "../src/index.css"

const [state, setState] = createStore({ message: MODEL_ACCESS_REQUIRED, opened: "", calls: 0 })
const platform: Platform = {
  platform: "desktop",
  os: "linux",
  openDirectoryPickerDialog: async () => null,
  openExternal: (url) => setState({ opened: url, calls: state.calls + 1 }),
  restart: async () => {
    throw new Error("Recovery must not restart Desktop")
  },
  notify: async () => {},
}
render(
  () => (
    <PlatformProvider value={platform}>
      <LanguageProvider locale="en">
        <main style={{ padding: "24px", "max-width": "700px" }}>
          <Card variant="error" class="error-card">
            {state.message}
            <ModelRecovery message={state.message} requestKey="student-fixture" />
          </Card>
          <button onClick={() => setState("message", "Daily token allowance reached")}>Other error</button>
          <output data-testid="opened">{state.opened}</output>
          <output data-testid="calls">{state.calls}</output>
        </main>
      </LanguageProvider>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
