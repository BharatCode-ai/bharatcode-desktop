// Only product-owned copy is branded. Provider names, documentation about
// upstream formats, arbitrary text and configuration paths are not rewritten.
const names = new Set([
  "app.name.desktop",
  "desktop.menu.app",
  "desktop.menu.documentation",
  "desktop.menu.ariaLabel",
  "desktop.recovery.loadFailed",
  "desktop.recovery.terminated",
  "desktop.recovery.unresponsive",
  "dialog.server.description",
  "help.tabs.introduction",
  "toast.update.description",
  "error.page.report.prefix",
  "settings.general.row.language.description",
  "settings.general.row.appearance.description",
  "settings.general.row.colorScheme.description",
  "settings.general.row.theme.description",
  "settings.updates.row.startup.description",
  "settings.updates.toast.latest.description",
  "provider.connect.apiKey.description",
  "provider.connect.oauth.code.visit.suffix",
  "provider.connect.oauth.auto.visit.suffix",
])

export function productDictionary<T extends Record<string, string>>(dictionary: T): { [K in keyof T]: string } {
  return Object.fromEntries(
    Object.entries(dictionary).map(([key, value]) => [
      key,
      names.has(key) ? value.replaceAll("OpenCode", "BharatCode") : value,
    ]),
  ) as { [K in keyof T]: string }
}
