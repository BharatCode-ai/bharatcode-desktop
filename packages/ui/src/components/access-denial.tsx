import { For, Show } from "solid-js"
import { accessDenialParagraphs } from "@opencode-ai/core/util/access-denial"

export function AccessDenial(props: { message: string }) {
  return (
    <Show when={accessDenialParagraphs(props.message)} fallback={props.message}>
      {(paragraphs) => (
        <div class="flex flex-col gap-3" data-component="access-denial">
          <For each={paragraphs()}>
            {(parts) => (
              <p>
                <For each={parts}>
                  {(part) => (
                    <Show when={part.href} fallback={part.text}>
                      {(href) => (
                        <a
                          href={href()}
                          class="external-link underline underline-offset-2"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {part.text}
                        </a>
                      )}
                    </Show>
                  )}
                </For>
              </p>
            )}
          </For>
        </div>
      )}
    </Show>
  )
}
