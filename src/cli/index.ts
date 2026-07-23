#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { VERSION } from "../version.ts";
import add from "./commands/add.ts";
import doctor from "./commands/doctor.ts";
import fetchCmd from "./commands/fetch.ts";
import inspect from "./commands/inspect.ts";
import installSkill from "./commands/install-skill.ts";
import list from "./commands/list.ts";
import mcp from "./commands/mcp.ts";
import query from "./commands/query.ts";
import remove from "./commands/remove.ts";
import resetConfig from "./commands/reset-config.ts";
import tui from "./commands/tui.ts";
import update from "./commands/update.ts";

const main = defineCommand({
  meta: {
    name: "localdoc",
    version: VERSION,
    description: "Offline-first documentation index for AI agents",
  },
  subCommands: {
    add,
    update,
    remove,
    list,
    query,
    inspect,
    doctor,
    "reset-config": resetConfig,
    fetch: fetchCmd,
    "install-skill": installSkill,
    mcp,
    tui,
  },
});

// If invoked with no args on a TTY, open the TUI.
const argv = process.argv.slice(2).filter((a) => a !== "--");
if (argv.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
  const { startTui } = await import("../tui/app.tsx");
  await startTui();
} else {
  await runMain(main);
}
