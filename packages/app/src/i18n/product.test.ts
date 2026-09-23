import { expect, test } from "bun:test"
import { productDictionary } from "./product"
import { DESKTOP_NATIVE_ENGLISH, desktopNativeMessages } from "./desktop-native"

test("product names change without rewriting provider names, placeholders or translated grammar", () => {
  const values = {
    "app.name.desktop": "OpenCode Desktop",
    "help.tabs.introduction": "OpenCode Desktopでタブを中心とした操作ができるようになりました。",
    "toast.update.description": "OpenCode ({{version}})",
    "provider.connect.opencodeZen.line1": "OpenCode Zen",
    "custom.config": "/home/OpenCode/project",
  }
  const branded = productDictionary(values)
  expect(branded["app.name.desktop"]).toBe("BharatCode Desktop")
  expect(branded["help.tabs.introduction"]).toBe("BharatCode Desktopでタブを中心とした操作ができるようになりました。")
  expect(branded["toast.update.description"]).toBe("BharatCode ({{version}})")
  expect(branded["provider.connect.opencodeZen.line1"]).toBe("OpenCode Zen")
  expect(branded["custom.config"]).toBe(values["custom.config"])
  expect(values["app.name.desktop"]).toBe("OpenCode Desktop")
})

test("native fallback and positional translations use the same product identity", () => {
  expect(DESKTOP_NATIVE_ENGLISH["desktop.menu.app"]).toBe("BharatCode")
  expect(DESKTOP_NATIVE_ENGLISH["desktop.recovery.unresponsive"]).toBe("BharatCode is not responding")
  const messages = desktopNativeMessages(["OpenCode", "Fichier"])
  expect(messages["desktop.menu.app"]).toBe("BharatCode")
  expect(messages["desktop.menu.file"]).toBe("Fichier")
  expect(messages["desktop.account.error.status"]).toBe(DESKTOP_NATIVE_ENGLISH["desktop.account.error.status"])
})
