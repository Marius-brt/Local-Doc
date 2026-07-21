/**
 * Copy text to the system clipboard via OS tools (pbcopy / wl-copy / clip).
 * OSC 52 is unreliable in IDE terminals (Cursor/VS Code).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      return await pipeToCommand(["pbcopy"], text);
    }
    if (platform === "win32") {
      return await pipeToCommand(["clip"], text);
    }
    for (const cmd of [["wl-copy"], ["xclip", "-selection", "clipboard"]] as const) {
      if (await pipeToCommand([...cmd], text)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function pipeToCommand(cmd: string[], text: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(cmd, {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    const stdin = proc.stdin;
    if (!stdin) return false;
    stdin.write(text);
    await stdin.end();
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}
