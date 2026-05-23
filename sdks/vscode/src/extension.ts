// This method is called when your extension is deactivated
export function deactivate() {}

import * as vscode from "vscode";

import {
  BHARATCODE_COMMANDS,
  BHARATCODE_EXTENSION,
  buildAuthTerminalText,
  buildLaunchTerminalText,
} from "./bharatcode";

export function activate(context: vscode.ExtensionContext) {
  const signInDisposable = vscode.commands.registerCommand(BHARATCODE_COMMANDS.signIn, async () => {
    const terminal = vscode.window.createTerminal({
      name: BHARATCODE_EXTENSION.authTerminalName,
      location: {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
      },
    });
    terminal.show();
    terminal.sendText(buildAuthTerminalText());
  });

  const openNewTerminalDisposable = vscode.commands.registerCommand(BHARATCODE_COMMANDS.openNewTerminal, async () => {
    await openTerminal();
  });

  const openTerminalDisposable = vscode.commands.registerCommand(BHARATCODE_COMMANDS.openTerminal, async () => {
    const existingTerminal = vscode.window.terminals.find((t) => t.name === BHARATCODE_EXTENSION.terminalName);
    if (existingTerminal) {
      existingTerminal.show();
      return;
    }

    await openTerminal();
  });

  const addFilepathDisposable = vscode.commands.registerCommand(BHARATCODE_COMMANDS.addFilepathToTerminal, async () => {
    const fileRef = getActiveFile();
    if (!fileRef) {
      return;
    }

    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      return;
    }

    if (terminal.name === BHARATCODE_EXTENSION.terminalName) {
      // @ts-ignore
      const port = terminal.creationOptions.env?.["_EXTENSION_OPENCODE_PORT"];
      port ? await appendPrompt(parseInt(port), fileRef) : terminal.sendText(fileRef, false);
      terminal.show();
    }
  });

  context.subscriptions.push(signInDisposable, openNewTerminalDisposable, openTerminalDisposable, addFilepathDisposable);

  async function openTerminal() {
    const port = Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384;
    const terminal = vscode.window.createTerminal({
      name: BHARATCODE_EXTENSION.terminalName,
      iconPath: {
        light: vscode.Uri.file(context.asAbsolutePath("images/button-dark.svg")),
        dark: vscode.Uri.file(context.asAbsolutePath("images/button-light.svg")),
      },
      location: {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
      },
      env: {
        _EXTENSION_OPENCODE_PORT: port.toString(),
        OPENCODE_CALLER: "vscode",
        BHARATCODE_CLIENT: "vscode",
      },
    });

    terminal.show();
    terminal.sendText(buildLaunchTerminalText(port));

    const fileRef = getActiveFile();
    if (!fileRef) {
      return;
    }

    // Wait for the terminal to be ready
    let tries = 10;
    let connected = false;
    do {
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        await fetch(`http://localhost:${port}/app`);
        connected = true;
        break;
      } catch {}

      tries--;
    } while (tries > 0);

    // If connected, append the prompt to the terminal
    if (connected) {
      await appendPrompt(port, `In ${fileRef}`);
      terminal.show();
    }
  }

  async function appendPrompt(port: number, text: string) {
    await fetch(`http://localhost:${port}/tui/append-prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
  }

  function getActiveFile() {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      return;
    }

    const document = activeEditor.document;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return;
    }

    // Get the relative path from workspace root
    const relativePath = vscode.workspace.asRelativePath(document.uri);
    let filepathWithAt = `@${relativePath}`;

    // Check if there's a selection and add line numbers
    const selection = activeEditor.selection;
    if (!selection.isEmpty) {
      // Convert to 1-based line numbers
      const startLine = selection.start.line + 1;
      const endLine = selection.end.line + 1;

      if (startLine === endLine) {
        // Single line selection
        filepathWithAt += `#L${startLine}`;
      } else {
        // Multi-line selection
        filepathWithAt += `#L${startLine}-${endLine}`;
      }
    }

    return filepathWithAt;
  }
}
