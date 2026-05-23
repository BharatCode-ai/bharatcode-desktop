import { describe, expect, test } from "bun:test";

import {
  BHARATCODE_COMMANDS,
  BHARATCODE_EXTENSION,
  BHARATCODE_OAUTH,
  buildAuthTerminalText,
  buildLaunchTerminalText,
} from "./bharatcode";

describe("BharatCode VS Code extension contract", () => {
  test("uses BharatCode metadata and command ids", () => {
    expect(BHARATCODE_EXTENSION.terminalName).toBe("BharatCode");
    expect(BHARATCODE_EXTENSION.publisher).toBe("bharatcode");
    expect(BHARATCODE_EXTENSION.packageName).toBe("bharatcode");
    expect(BHARATCODE_COMMANDS.signIn).toBe("bharatcode.signIn");
    expect(BHARATCODE_COMMANDS.openTerminal).toBe("bharatcode.openTerminal");
    expect(BHARATCODE_COMMANDS.openNewTerminal).toBe("bharatcode.openNewTerminal");
  });

  test("launches the BharatCode CLI by default", () => {
    expect(buildLaunchTerminalText(27182)).toBe("bharatcode --port 27182");
    expect(buildAuthTerminalText()).toBe("bharatcode auth login && bharatcode opencode configure");
  });

  test("uses the shared native OAuth backend", () => {
    expect(BHARATCODE_OAUTH.issuer).toBe("https://evgvlcaxfpwupaiwzqqm.supabase.co/auth/v1");
    expect(BHARATCODE_OAUTH.nativeClientId).toBe("4cad332a-232f-4ef2-9363-12fea4420635");
    expect(BHARATCODE_OAUTH.vscodeRedirectUri).toBe("vscode://bharatcode.bharatcode/auth/callback");
    expect(BHARATCODE_OAUTH.modelProxy).toBe("https://bharatcode.ai/api/model/v1");
  });
});
