#!/usr/bin/env bun
/**
 * Compile entry — same CLI as the Bun runtime entry, including OpenTUI.
 * Playwright remains stubbed; Transformers.js + Model2Vec sidecar are embedded.
 */
import "./embed-libsql.ts";
import "./embed-model2vec.ts";
import "./embed-onnx.generated.ts";
import "./embed-chonkie.ts";
import { defineCommand, runMain } from "citty";
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
    version: "0.1.0",
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

// No args on a TTY → launch TUI (including when run as a compiled binary).
const argv = process.argv.slice(2).filter((a) => a !== "--");
if (argv.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
  const { startTui } = await import("../tui/app.tsx");
  await startTui();
} else {
  await runMain(main);
}
