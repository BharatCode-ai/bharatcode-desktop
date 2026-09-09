import { accessDenialParagraphs, accessDenialPlainLink } from "@opencode-ai/core/util/access-denial"

export function formatAccessDenial(message: string, hyperlinks: boolean) {
  const paragraphs = hyperlinks && accessDenialParagraphs(message)
  if (!paragraphs) return message
  return paragraphs
    .map((parts) =>
      parts
        .map((part) => {
          const text = accessDenialPlainLink(part)
          return part.href ? `\u001b]8;;${part.href}\u001b\\${text}\u001b]8;;\u001b\\` : text
        })
        .join(""),
    )
    .join("\n\n")
}
