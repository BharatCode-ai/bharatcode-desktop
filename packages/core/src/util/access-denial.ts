type Part = Readonly<{ text: string; href?: string }>

const paragraphs: readonly (readonly Part[])[] = [
  [
    { text: "BharatCode App requires Pro or student access. " },
    { text: "Subscribe to Pro", href: "https://bharatcode.ai/subscribe" },
    { text: ", or sign in with your student email. Need verification? Contact " },
    { text: "help@bharatcode.ai", href: "mailto:help@bharatcode.ai" },
    { text: "." },
  ],
  [{ text: "BharatCode Chat", href: "https://chat.bharatcode.ai" }, { text: " is free for everyone." }],
]

export function accessDenialPlainLink(part: Part) {
  return part.href && !part.href.startsWith("mailto:") ? `${part.text} (${part.href})` : part.text
}

export const ACCESS_DENIAL_MESSAGE = paragraphs.map((parts) => parts.map(accessDenialPlainLink).join("")).join("\n\n")

// Only this exact canonical message gains fixed, trusted links. Never parse server HTML or URLs.
export function accessDenialParagraphs(message: string) {
  return message === ACCESS_DENIAL_MESSAGE ? paragraphs : undefined
}
