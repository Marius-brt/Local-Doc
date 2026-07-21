import { describe, expect, test } from "bun:test";
import {
  classicCopyShortcutLabel,
  classicQuitShortcutLabel,
  isClassicCopyShortcut,
  isQuitCtrlC,
} from "../src/util/copy-shortcut.ts";

describe("classic copy shortcuts", () => {
  test("labels follow the OS", () => {
    expect(classicCopyShortcutLabel("darwin")).toBe("Cmd+C");
    expect(classicCopyShortcutLabel("linux")).toBe("Ctrl+C");
    expect(classicCopyShortcutLabel("win32")).toBe("Ctrl+C");
    expect(classicQuitShortcutLabel("darwin")).toBe("q / Ctrl+C");
    expect(classicQuitShortcutLabel("linux")).toBe("q");
  });

  test("macOS uses Cmd+C (super or meta), not Ctrl+C", () => {
    expect(isClassicCopyShortcut({ name: "c", super: true }, "darwin")).toBe(true);
    expect(isClassicCopyShortcut({ name: "c", meta: true }, "darwin")).toBe(true);
    expect(isClassicCopyShortcut({ name: "c", ctrl: true }, "darwin")).toBe(false);
    expect(isClassicCopyShortcut({ name: "c", ctrl: true, shift: true }, "darwin")).toBe(false);
    expect(isQuitCtrlC({ name: "c", ctrl: true }, "darwin")).toBe(true);
  });

  test("Windows/Linux use Ctrl+C for copy", () => {
    expect(isClassicCopyShortcut({ name: "c", ctrl: true }, "linux")).toBe(true);
    expect(isClassicCopyShortcut({ name: "C", ctrl: true }, "win32")).toBe(true);
    expect(isClassicCopyShortcut({ name: "c", ctrl: true, shift: true }, "linux")).toBe(false);
    expect(isClassicCopyShortcut({ name: "c", super: true }, "linux")).toBe(false);
    expect(isClassicCopyShortcut({ name: "c", meta: true }, "linux")).toBe(false);
    expect(isQuitCtrlC({ name: "c", ctrl: true }, "linux")).toBe(false);
    expect(isQuitCtrlC({ name: "c", ctrl: true }, "win32")).toBe(false);
  });
});
