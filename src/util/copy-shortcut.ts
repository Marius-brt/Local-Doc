/** Key-like shape from OpenTUI `useKeyboard` / KeyEvent. */
export type CopyKeyEvent = {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  super?: boolean;
};

export function isMacPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

/** Classic OS copy label: Cmd+C on macOS, Ctrl+C elsewhere. */
export function classicCopyShortcutLabel(platform: NodeJS.Platform = process.platform): string {
  return isMacPlatform(platform) ? "Cmd+C" : "Ctrl+C";
}

export function classicQuitShortcutLabel(platform: NodeJS.Platform = process.platform): string {
  return isMacPlatform(platform) ? "q / Ctrl+C" : "q";
}

/**
 * Classic OS copy chord:
 * - macOS: Cmd+C (`super`; some terminals still report Command as `meta`)
 * - Windows/Linux: Ctrl+C
 */
export function isClassicCopyShortcut(
  key: CopyKeyEvent,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const isC = key.name === "c" || key.name === "C";
  if (!isC) return false;

  if (isMacPlatform(platform)) {
    return Boolean((key.super === true || key.meta) && !key.ctrl);
  }

  return Boolean(key.ctrl && !key.shift && !key.meta && key.super !== true);
}

/** Ctrl+C quit — only on macOS, where copy is Cmd+C. */
export function isQuitCtrlC(
  key: CopyKeyEvent,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!isMacPlatform(platform)) return false;
  const isC = key.name === "c" || key.name === "C";
  return Boolean(isC && key.ctrl && !key.shift);
}
