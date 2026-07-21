import type { Client } from "@libsql/client";
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
import { useCallback, useEffect, useState } from "react";
import { type LoadedConfig, loadConfig } from "../config/load.ts";
import { getDb } from "../db/client.ts";
import { countStats } from "../db/documents.ts";
import { listSources, type SourceRow } from "../db/sources.ts";
import { tryCreateEmbedder } from "../embed/index.ts";
import { buildContextPack, formatPackMarkdown } from "../pack/format.ts";
import { hybridSearch } from "../search/hybrid.ts";
import { ingestTarget } from "../sources/ingest.ts";

type View = "sources" | "query" | "inspect" | "add";

const VIEWS: Array<{ id: View; label: string; key: string }> = [
  { id: "sources", label: "Sources", key: "1" },
  { id: "query", label: "Query", key: "2" },
  { id: "inspect", label: "Inspect", key: "3" },
  { id: "add", label: "Add", key: "4" },
];

const COLORS = {
  bg: "#0d1117",
  panel: "#161b22",
  border: "#30363d",
  accent: "#58a6ff",
  muted: "#8b949e",
  text: "#e6edf3",
  green: "#3fb950",
  yellow: "#d29922",
  red: "#f85149",
  selected: "#1f6feb",
};

interface AppState {
  loaded: LoadedConfig | null;
  db: Client | null;
  sources: SourceRow[];
  stats: string;
  status: string;
  error: string | null;
}

function App() {
  const renderer = useRenderer();
  const [view, setView] = useState<View>("sources");
  const [state, setState] = useState<AppState>({
    loaded: null,
    db: null,
    sources: [],
    stats: "",
    status: "Loading…",
    error: null,
  });
  const [sourceCursor, setSourceCursor] = useState(0);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState("");
  const [searching, setSearching] = useState(false);
  const [addTarget, setAddTarget] = useState("");
  const [addLog, setAddLog] = useState("");
  const [adding, setAdding] = useState(false);
  const [focus, setFocus] = useState<"nav" | "main" | "input">("main");

  const refresh = useCallback(async () => {
    try {
      const loaded = await loadConfig();
      const db = await getDb(loaded.dataDir);
      const sources = await listSources(db);
      const st = await countStats(db);
      setState({
        loaded,
        db,
        sources,
        stats: `${st.sources} sources · ${st.documents} docs · ${st.chunks} chunks · ${st.embeddings} embeddings`,
        status: loaded.dataDir,
        error: null,
      });
      setSourceCursor((c) => Math.min(c, Math.max(0, sources.length - 1)));
    } catch (err) {
      setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : String(err),
        status: "Error",
      }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runQuery = useCallback(
    async (q: string) => {
      if (!q.trim() || !state.loaded || !state.db) return;
      setSearching(true);
      setResult("Searching…");
      try {
        const embedder = await tryCreateEmbedder(state.loaded.config, state.loaded.dataDir);
        const hits = await hybridSearch(state.db, q, state.loaded.config, embedder);
        const pack = buildContextPack(q, hits, state.loaded.config.search.budget_tokens);
        setResult(formatPackMarkdown(pack));
        setFocus("main");
      } catch (err) {
        setResult(err instanceof Error ? err.message : String(err));
      } finally {
        setSearching(false);
      }
    },
    [state.loaded, state.db],
  );

  const runAdd = useCallback(
    async (target: string) => {
      if (!target.trim() || !state.loaded || !state.db) return;
      setAdding(true);
      setAddLog(`Indexing ${target}…`);
      try {
        const report = await ingestTarget(
          state.db,
          state.loaded.config,
          state.loaded.dataDir,
          target,
          {
            onProgress: (p) => {
              setAddLog(
                p.current && p.total
                  ? `[${p.phase}] ${p.current}/${p.total} ${p.message ?? ""}`
                  : `[${p.phase}] ${p.message ?? ""}`,
              );
            },
          },
        );
        setAddLog(
          `Done: ${report.pagesOk} ok, ${report.pagesSkipped} skipped, ${report.pagesFailed} failed` +
            (report.strategy ? ` (${report.strategy})` : ""),
        );
        await refresh();
      } catch (err) {
        setAddLog(err instanceof Error ? err.message : String(err));
      } finally {
        setAdding(false);
      }
    },
    [state.loaded, state.db, refresh],
  );

  const quit = useCallback(() => {
    renderer.destroy();
    process.exit(0);
  }, [renderer]);

  const goToView = useCallback((next: View) => {
    setView(next);
    setFocus(next === "query" || next === "add" ? "input" : "main");
  }, []);

  const [hoveredNav, setHoveredNav] = useState<View | "refresh" | "quit" | null>(null);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      quit();
      return;
    }
    if (key.name === "escape") {
      setFocus("main");
      return;
    }

    if (key.name === "1") {
      goToView("sources");
      return;
    }
    if (key.name === "2") {
      goToView("query");
      return;
    }
    if (key.name === "3") {
      goToView("inspect");
      return;
    }
    if (key.name === "4") {
      goToView("add");
      return;
    }
    if (key.name === "r" && focus !== "input") {
      void refresh();
      return;
    }
    if ((key.name === "q" || key.name === "Q") && focus !== "input") {
      quit();
      return;
    }

    if (view === "sources" && focus !== "input") {
      if (key.name === "up" || key.name === "k") {
        setSourceCursor((c) => Math.max(0, c - 1));
      }
      if (key.name === "down" || key.name === "j") {
        setSourceCursor((c) => Math.min(Math.max(state.sources.length - 1, 0), c + 1));
      }
    }
  });

  const selected = state.sources[sourceCursor] ?? null;

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={COLORS.bg}>
      <box
        width="100%"
        height={3}
        border
        borderColor={COLORS.border}
        backgroundColor={COLORS.panel}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
      >
        <text fg={COLORS.accent}>
          <strong>localdoc</strong>
        </text>
        <text fg={state.error ? COLORS.red : COLORS.muted}>{state.error ?? state.status}</text>
        <text fg={COLORS.muted}>{state.stats || "…"}</text>
      </box>

      <box width="100%" flexGrow={1} flexDirection="row">
        <box
          width={22}
          height="100%"
          border
          borderColor={COLORS.border}
          backgroundColor={COLORS.panel}
          title="Navigate"
          titleColor={COLORS.accent}
          flexDirection="column"
          padding={1}
        >
          {VIEWS.map((v) => {
            const active = view === v.id;
            const hovered = hoveredNav === v.id;
            return (
              <box
                key={v.id}
                width="100%"
                paddingLeft={1}
                backgroundColor={active ? COLORS.selected : hovered ? COLORS.border : undefined}
                onMouseDown={() => goToView(v.id)}
                onMouseOver={() => setHoveredNav(v.id)}
                onMouseOut={() => setHoveredNav((h) => (h === v.id ? null : h))}
              >
                <text fg={active || hovered ? COLORS.text : COLORS.muted}>
                  {v.key} {v.label}
                </text>
              </box>
            );
          })}
          <box
            marginTop={1}
            width="100%"
            paddingLeft={1}
            backgroundColor={hoveredNav === "refresh" ? COLORS.border : undefined}
            onMouseDown={() => void refresh()}
            onMouseOver={() => setHoveredNav("refresh")}
            onMouseOut={() => setHoveredNav((h) => (h === "refresh" ? null : h))}
          >
            <text fg={hoveredNav === "refresh" ? COLORS.text : COLORS.muted}>r refresh</text>
          </box>
          <box
            width="100%"
            paddingLeft={1}
            backgroundColor={hoveredNav === "quit" ? COLORS.border : undefined}
            onMouseDown={() => quit()}
            onMouseOver={() => setHoveredNav("quit")}
            onMouseOut={() => setHoveredNav((h) => (h === "quit" ? null : h))}
          >
            <text fg={hoveredNav === "quit" ? COLORS.text : COLORS.muted}>q quit</text>
          </box>
        </box>

        <box
          flexGrow={1}
          height="100%"
          border
          borderColor={COLORS.border}
          backgroundColor={COLORS.bg}
          title={VIEWS.find((v) => v.id === view)?.label ?? ""}
          titleColor={COLORS.accent}
          flexDirection="column"
          padding={1}
        >
          {view === "sources" && (
            <box flexDirection="row" width="100%" height="100%" gap={1}>
              <scrollbox
                width="45%"
                height="100%"
                focused={focus === "main"}
                style={{
                  rootOptions: { backgroundColor: COLORS.panel },
                  scrollbarOptions: {
                    trackOptions: {
                      foregroundColor: COLORS.accent,
                      backgroundColor: COLORS.border,
                    },
                  },
                }}
              >
                {state.sources.length === 0 ? (
                  <text fg={COLORS.muted}>No sources. Press 4 to add.</text>
                ) : (
                  state.sources.map((s, i) => (
                    <box
                      key={s.id}
                      width="100%"
                      paddingLeft={1}
                      backgroundColor={i === sourceCursor ? COLORS.selected : undefined}
                      onMouseDown={() => {
                        setSourceCursor(i);
                        setFocus("main");
                      }}
                    >
                      <text fg={i === sourceCursor ? COLORS.text : COLORS.muted}>
                        {s.kind.padEnd(7)} {s.status}
                      </text>
                      <text fg={COLORS.muted}>{s.root_uri}</text>
                    </box>
                  ))
                )}
              </scrollbox>
              <box
                flexGrow={1}
                height="100%"
                border
                borderColor={COLORS.border}
                padding={1}
                flexDirection="column"
                title="Detail"
                titleColor={COLORS.muted}
              >
                {selected ? (
                  <box flexDirection="column" gap={0}>
                    <text fg={COLORS.accent}>{selected.title || selected.id}</text>
                    <text fg={COLORS.muted}>id: {selected.id}</text>
                    <text fg={COLORS.muted}>kind: {selected.kind}</text>
                    <text fg={COLORS.muted}>status: {selected.status}</text>
                    <text fg={COLORS.muted}>strategy: {selected.strategy ?? "—"}</text>
                    <text fg={COLORS.text}>{selected.root_uri}</text>
                    <text fg={COLORS.muted}>updated: {selected.updated_at}</text>
                  </box>
                ) : (
                  <text fg={COLORS.muted}>Select a source (j/k or ↑/↓)</text>
                )}
              </box>
            </box>
          )}

          {view === "query" && (
            <box flexDirection="column" width="100%" height="100%" gap={1}>
              <box
                width="100%"
                height={3}
                border
                borderColor={focus === "input" ? COLORS.accent : COLORS.border}
                title="Query"
                titleColor={COLORS.accent}
              >
                <input
                  placeholder="Search indexed docs…"
                  focused={focus === "input"}
                  onInput={setQuery}
                  onSubmit={(v: string) => void runQuery(v)}
                />
              </box>
              <scrollbox
                width="100%"
                flexGrow={1}
                focused={focus === "main"}
                style={{
                  rootOptions: { backgroundColor: COLORS.panel },
                  scrollbarOptions: {
                    trackOptions: {
                      foregroundColor: COLORS.accent,
                      backgroundColor: COLORS.border,
                    },
                  },
                }}
              >
                {searching ? (
                  <text fg={COLORS.yellow}>Searching…</text>
                ) : result ? (
                  result.split("\n").map((line, i) => (
                    <text key={`line-${String(i)}-${line.slice(0, 8)}`} fg={COLORS.text}>
                      {line || " "}
                    </text>
                  ))
                ) : (
                  <text fg={COLORS.muted}>Type a query and press Enter. Results appear here.</text>
                )}
              </scrollbox>
            </box>
          )}

          {view === "inspect" && (
            <box flexDirection="column" gap={1} padding={1}>
              <text fg={COLORS.accent}>Index</text>
              <text fg={COLORS.text}>{state.stats || "—"}</text>
              <text fg={COLORS.muted}>config: {state.loaded?.configPath ?? "—"}</text>
              <text fg={COLORS.muted}>data: {state.loaded?.dataDir ?? "—"}</text>
              <text fg={COLORS.muted}>
                embeddings: {state.loaded?.config.embeddings.provider ?? "—"} /{" "}
                {state.loaded?.config.embeddings.model ?? "—"}
              </text>
              <text fg={COLORS.muted}>
                rerank:{" "}
                {state.loaded?.config.rerank.enabled
                  ? state.loaded.config.rerank.provider
                  : "disabled"}
              </text>
              <text fg={COLORS.muted}>
                playwright: {state.loaded?.config.crawl.playwright ?? "—"}
              </text>
              <box marginTop={1}>
                <text fg={COLORS.muted}>Press r to refresh stats</text>
              </box>
            </box>
          )}

          {view === "add" && (
            <box flexDirection="column" width="100%" height="100%" gap={1}>
              <box
                width="100%"
                height={3}
                border
                borderColor={focus === "input" ? COLORS.accent : COLORS.border}
                title="URL · GitHub · folder"
                titleColor={COLORS.accent}
              >
                <input
                  placeholder="https://docs…  |  github.com/org/repo  |  ./docs"
                  focused={focus === "input"}
                  onInput={setAddTarget}
                  onSubmit={(v: string) => void runAdd(v)}
                />
              </box>
              <scrollbox
                width="100%"
                flexGrow={1}
                style={{
                  rootOptions: { backgroundColor: COLORS.panel },
                }}
              >
                {adding ? (
                  <text fg={COLORS.yellow}>{addLog || "Working…"}</text>
                ) : addLog ? (
                  <text fg={addLog.startsWith("Done") ? COLORS.green : COLORS.text}>{addLog}</text>
                ) : (
                  <text fg={COLORS.muted}>
                    Paste a docs URL, GitHub repo, or local folder path, then Enter.
                  </text>
                )}
              </scrollbox>
            </box>
          )}
        </box>
      </box>

      <box width="100%" height={1} backgroundColor={COLORS.panel} paddingLeft={1}>
        <text fg={COLORS.muted}>
          click sidebar · 1–4 views · ↑↓/jk sources · Enter submit · q / Ctrl+C quit · query=
          {query ? `"${query.slice(0, 40)}"` : "—"}
          {addTarget && view === "add" ? ` · add="${addTarget.slice(0, 40)}"` : ""}
        </text>
      </box>
    </box>
  );
}

export async function startTui(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
  });
  createRoot(renderer).render(<App />);
  await new Promise<void>(() => {
    // OpenTUI keeps the process alive until renderer.destroy() / process.exit
  });
}
