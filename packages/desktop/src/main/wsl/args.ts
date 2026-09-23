export function wslArgs(args: string[], distro?: string | null, user?: string | null, cwd?: string) {
  return [
    ...(distro ? ["-d", distro] : []),
    ...(user ? ["--user", user] : []),
    ...(cwd ? ["--cd", cwd] : []),
    // Bare -- still invokes the default shell, which consumes Windows path
    // backslashes and shell metacharacters. Shell scripts opt in via sh -lc.
    "--exec",
    ...args,
  ]
}
