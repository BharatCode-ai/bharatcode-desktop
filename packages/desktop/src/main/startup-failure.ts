export function reportStartupFailure(
  input: {
    log: (error: unknown) => void
    showError: (title: string, message: string) => void
    exit: (code: number) => void
  },
  error: unknown,
) {
  try {
    input.log(error)
  } catch {}
  input.showError(
    "BharatCode could not start",
    "A required desktop component could not start. Reinstall the latest BharatCode Desktop build. Your projects were not changed.",
  )
  input.exit(1)
}
