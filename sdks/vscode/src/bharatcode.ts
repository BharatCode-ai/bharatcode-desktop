export const BHARATCODE_EXTENSION = {
  terminalName: "BharatCode",
  authTerminalName: "BharatCode Auth",
  publisher: "bharatcode",
  packageName: "bharatcode",
};

export const BHARATCODE_COMMANDS = {
  signIn: "bharatcode.signIn",
  openTerminal: "bharatcode.openTerminal",
  openNewTerminal: "bharatcode.openNewTerminal",
  addFilepathToTerminal: "bharatcode.addFilepathToTerminal",
};

export const BHARATCODE_OAUTH = {
  issuer: "https://evgvlcaxfpwupaiwzqqm.supabase.co/auth/v1",
  nativeClientId: "4cad332a-232f-4ef2-9363-12fea4420635",
  vscodeRedirectUri: "vscode://bharatcode.bharatcode/auth/callback",
  vscodeInsidersRedirectUri: "vscode-insiders://bharatcode.bharatcode/auth/callback",
  modelProxy: "https://bharatcode.ai/api/model/v1",
};

export function buildLaunchTerminalText(port: number) {
  return `bharatcode --port ${port}`;
}

export function buildAuthTerminalText() {
  return "bharatcode auth login && bharatcode opencode configure";
}
