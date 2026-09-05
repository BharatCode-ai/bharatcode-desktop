import { For, Show } from "solid-js"
import type { RGBA } from "@opentui/core"
import { accessDenialParagraphs, accessDenialPlainLink } from "@opencode-ai/core/util/access-denial"

export function AccessDenial(props: { message: string; fg: RGBA }) {
  return (
    <Show when={accessDenialParagraphs(props.message)} fallback={<text fg={props.fg}>{props.message}</text>}>
      {(paragraphs) => (
        <box flexDirection="column" gap={1}>
          <For each={paragraphs()}>
            {(parts) => (
              <text fg={props.fg}>
                <For each={parts}>
                  {(part) => (
                    <Show when={part.href} fallback={part.text}>
                      {(href) => <a href={href()}>{accessDenialPlainLink(part)}</a>}
                    </Show>
                  )}
                </For>
              </text>
            )}
          </For>
        </box>
      )}
    </Show>
  )
}
