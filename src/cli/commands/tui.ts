import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "tui", description: "Interactive terminal UI" },
  async run() {
    const { startTui } = await import("../../tui/app.tsx");
    await startTui();
  },
});
