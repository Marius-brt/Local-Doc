import type { Client } from "@libsql/client";
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer, useSelectionHandler } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type LoadedConfig, loadConfig } from "../config/load.ts";
import { getDb } from "../db/client.ts";
import { countStats } from "../db/documents.ts";
import { listSources, removeSource, type SourceRow } from "../db/sources.ts";
import { tryCreateEmbedder } from "../embed/index.ts";
import { buildContextPack, formatPackMarkdown } from "../pack/format.ts";
import { hybridSearch } from "../search/hybrid.ts";
import { ingestTarget } from "../sources/ingest.ts";
import { reembedChunks } from "../sources/reembed.ts";
import { copyToClipboard } from "../util/clipboard.ts";
import {
  classicCopyShortcutLabel,
  classicQuitShortcutLabel,
  isClassicCopyShortcut,
  isQuitCtrlC,
} from "../util/copy-shortcut.ts";
import { formatUriForDisplay } from "../util/file-uri.ts";
import { flushLog, formatError, log } from "../util/log.ts";

const COPY_KEY = classicCopyShortcutLabel();
const QUIT_KEYS = classicQuitShortcutLabel();

type View = "sources" | "query" | "inspect" | "add";

const VIEWS: Array<{ id: View; label: string; key: string }> = [
  { id: "sources", label: "Sources", key: "1" },
  { id: "query", label: "Query", key: "2" },
  { id: "inspect", label: "Inspect", key: "3" },
  { id: "add", label: "Add", key: "4" },
];

function throwIfBusyAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const err = new Error("Cancelled");
    err.name = "AbortError";
    throw err;
  }
}

/** Progress messages that represent a visited page/file (not status summaries). */
function visitFromProgress(phase: string, message?: string): string | null {
  if (!message?.trim()) return null;
  const msg = message.trim();
  if (phase === "fetch" || phase === "index") {
    if (/^Fetching \d+ /.test(msg) || msg.startsWith("Discovering") || msg.startsWith("Scanning")) {
      return null;
    }
    return msg;
  }
  if (phase === "browser") {
    const m = msg.match(/https?:\/\/\S+/);
    return m?.[0] ?? null;
  }
  return null;
}

/** Bordered action control — height 3 leaves one content row inside the border. */
function ActionButton(props: {
  label: string;
  fg: string;
  borderColor: string;
  backgroundColor?: string;
  flexGrow?: number;
  width?: number;
  onMouseDown: () => void;
  onMouseOver: () => void;
  onMouseOut: () => void;
}) {
  return (
    <box
      height={3}
      flexGrow={props.flexGrow}
      width={props.width}
      paddingLeft={1}
      paddingRight={1}
      border
      borderColor={props.borderColor}
      backgroundColor={props.backgroundColor}
      justifyContent="center"
      alignItems="center"
      onMouseDown={props.onMouseDown}
      onMouseOver={props.onMouseOver}
      onMouseOut={props.onMouseOut}
    >
      <text fg={props.fg}>{props.label}</text>
    </box>
  );
}

function formatIngestLog(header: string, status: string, visited: string[]): string {
  const body = visited.length > 0 ? visited.map((u) => `  ${u}`).join("\n") : "";
  return [header, status, body].filter(Boolean).join("\n");
}

/** Prefer end of long paths so filename/folder remains visible. */
function displayPath(value: string, max = 64): string {
  const s = formatUriForDisplay(value);
  if (s.length <= max) return s;
  return `…${s.slice(-(max - 1))}`;
}

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
  selectionBg: "#264F78",
  selectionFg: "#e6edf3",
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
  const [updateLog, setUpdateLog] = useState("");
  const [updating, setUpdating] = useState(false);
  const [focus, setFocus] = useState<"nav" | "main" | "input">("main");
  const [hoveredNav, setHoveredNav] = useState<
    View | "refresh" | "quit" | "cancel" | "update" | "update-all" | "reindex-all" | "remove" | null
  >(null);
  const abortRef = useRef<AbortController | null>(null);
  const queryGenRef = useRef(0);
  const selectionTextRef = useRef("");
  const [statusFlash, setStatusFlash] = useState<string | null>(null);

  const busy = searching || adding || updating;

  const copySelection = useCallback(async () => {
    const value = selectionTextRef.current.trimEnd();
    if (!value) {
      setStatusFlash("nothing selected");
      setTimeout(() => setStatusFlash(null), 1200);
      return false;
    }
    const ok = await copyToClipboard(value);
    setStatusFlash(ok ? "copied to clipboard" : "copy failed");
    setTimeout(() => setStatusFlash(null), 1500);
    return ok;
  }, []);

  // Track selection only — do not auto-copy on mouse release.
  useSelectionHandler((selection) => {
    selectionTextRef.current = selection.getSelectedText() ?? "";
  });

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

  const cancelWork = useCallback(() => {
    queryGenRef.current += 1;
    // Abort in-flight work; keep busy=true until the worker's finally clears it
    // so Escape / Cancel stay responsive and the AbortController remains reachable.
    abortRef.current?.abort();
    if (searching) {
      setSearching(false);
      setResult("Cancelled.");
    }
    if (adding) {
      setAddLog((l) => (l.includes("Cancel") ? l : `${l}\nCancelling…`));
    }
    if (updating) {
      setUpdateLog((l) => (l.includes("Cancel") ? l : `${l}\nCancelling…`));
    }
    setFocus(view === "query" || view === "add" ? "input" : "main");
  }, [searching, adding, updating, view]);

  const runQuery = useCallback(
    async (q: string) => {
      if (!q.trim() || !state.loaded || !state.db || busy) return;
      const gen = ++queryGenRef.current;
      setSearching(true);
      setFocus("main");
      setResult("Searching…");
      try {
        const embedder = await tryCreateEmbedder(state.loaded.config, state.loaded.dataDir);
        if (gen !== queryGenRef.current) return;
        const hits = await hybridSearch(state.db, q, state.loaded.config, embedder);
        if (gen !== queryGenRef.current) return;
        const pack = buildContextPack(q, hits, state.loaded.config.search.budget_tokens);
        setResult(formatPackMarkdown(pack));
      } catch (err) {
        if (gen !== queryGenRef.current) return;
        log.error(`query failed: ${formatError(err)}`);
        await flushLog();
        setResult(err instanceof Error ? err.message : String(err));
      } finally {
        if (gen === queryGenRef.current) {
          setSearching(false);
        }
      }
    },
    [state.loaded, state.db, busy],
  );

  const runAdd = useCallback(
    async (target: string) => {
      if (!target.trim() || !state.loaded || !state.db || busy) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setAdding(true);
      setFocus("main");
      const header = `Indexing ${target}…`;
      const visited: string[] = [];
      const seen = new Set<string>();
      let status = "[…] starting";
      const render = () => setAddLog(formatIngestLog(header, status, visited));
      render();
      try {
        const report = await ingestTarget(
          state.db,
          state.loaded.config,
          state.loaded.dataDir,
          target,
          {
            signal: ac.signal,
            onProgress: (p) => {
              if (ac.signal.aborted) return;
              status =
                p.current && p.total
                  ? `[${p.phase}] ${p.current}/${p.total}`
                  : `[${p.phase}] ${p.message && !visitFromProgress(p.phase, p.message) ? p.message : ""}`.trim();
              const visit = visitFromProgress(p.phase, p.message);
              if (visit && !seen.has(visit)) {
                seen.add(visit);
                visited.push(visit);
              }
              render();
            },
          },
        );
        if (ac.signal.aborted) {
          setAddLog("Cancelled.");
          return;
        }
        setAddLog(
          formatIngestLog(
            header,
            `Done: ${report.pagesOk} ok, ${report.pagesSkipped} skipped, ${report.pagesFailed} failed` +
              (report.strategy ? ` (${report.strategy})` : ""),
            visited,
          ),
        );
        await refresh();
      } catch (err) {
        if (ac.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          setAddLog("Cancelled.");
          return;
        }
        setAddLog(err instanceof Error ? err.message : String(err));
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
        setAdding(false);
        setFocus("input");
      }
    },
    [state.loaded, state.db, refresh, busy],
  );

  const runUpdate = useCallback(
    async (targets: string[], label: string) => {
      if (targets.length === 0 || !state.loaded || !state.db || busy) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setUpdating(true);
      setFocus("main");
      setView("sources");
      const lines: string[] = [];
      const push = (line: string) => {
        lines.push(line);
        setUpdateLog(lines.join("\n"));
      };
      push(`Updating ${label}…`);
      try {
        for (let i = 0; i < targets.length; i++) {
          throwIfBusyAborted(ac.signal);
          const target = targets[i]!;
          push(`[${i + 1}/${targets.length}] ${target}`);
          const visited: string[] = [];
          const seen = new Set<string>();
          const report = await ingestTarget(
            state.db,
            state.loaded.config,
            state.loaded.dataDir,
            target,
            {
              recreate: false,
              signal: ac.signal,
              onProgress: (p) => {
                if (ac.signal.aborted) return;
                const status =
                  p.current && p.total
                    ? `[${p.phase}] ${p.current}/${p.total}`
                    : `[${p.phase}] ${p.message && !visitFromProgress(p.phase, p.message) ? p.message : ""}`.trim();
                const visit = visitFromProgress(p.phase, p.message);
                if (visit && !seen.has(visit)) {
                  seen.add(visit);
                  visited.push(visit);
                }
                setUpdateLog([...lines, status, ...visited.map((u) => `  ${u}`)].join("\n"));
              },
            },
          );
          throwIfBusyAborted(ac.signal);
          for (const u of visited) {
            lines.push(`  ${u}`);
          }
          push(
            `  → ${report.pagesOk} ok, ${report.pagesSkipped} skipped, ${report.pagesFailed} failed` +
              (report.strategy ? ` (${report.strategy})` : ""),
          );
        }
        push("Done.");
        await refresh();
      } catch (err) {
        if (ac.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          push("Cancelled.");
          return;
        }
        push(err instanceof Error ? err.message : String(err));
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
        setUpdating(false);
      }
    },
    [state.loaded, state.db, refresh, busy],
  );

  const runReembed = useCallback(
    async (label: string, sourceId?: string) => {
      if (!state.loaded || !state.db || busy) return;
      if (!sourceId && state.sources.length === 0) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setUpdating(true);
      setFocus("main");
      setView("sources");
      setUpdateLog(`Re-embedding ${label} (no re-fetch)…`);
      let lastProgressAt = 0;
      try {
        const report = await reembedChunks(state.db, state.loaded.config, state.loaded.dataDir, {
          signal: ac.signal,
          sourceId,
          onProgress: (p) => {
            if (ac.signal.aborted) return;
            const now = Date.now();
            // Throttle UI updates so React/OpenTUI can still handle Escape / Cancel
            if (p.phase === "embed" && now - lastProgressAt < 120) return;
            lastProgressAt = now;
            setUpdateLog(
              p.current && p.total
                ? `[${p.phase}] ${p.current}/${p.total} ${p.message ?? ""}\nEsc / Cancel to stop`
                : `[${p.phase}] ${p.message ?? ""}\nEsc / Cancel to stop`,
            );
          },
        });
        if (ac.signal.aborted) {
          setUpdateLog("Cancelled.");
          return;
        }
        setUpdateLog(
          `Done: ${report.chunksEmbedded}/${report.chunksTotal} chunks · ${report.modelId} · ${report.dims}-d` +
            (report.previousDims != null && report.previousDims !== report.dims
              ? ` (was ${report.previousDims}-d)`
              : ""),
        );
        await refresh();
      } catch (err) {
        if (ac.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          setUpdateLog("Cancelled.");
          return;
        }
        setUpdateLog(err instanceof Error ? err.message : String(err));
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
        setUpdating(false);
      }
    },
    [state.loaded, state.db, state.sources.length, refresh, busy],
  );

  const runRemove = useCallback(
    async (src: SourceRow) => {
      if (!state.db || busy) return;
      try {
        const ok = await removeSource(state.db, src.id);
        setUpdateLog(ok ? `Removed ${src.title || src.root_uri}` : `Source not found: ${src.id}`);
        await refresh();
      } catch (err) {
        setUpdateLog(err instanceof Error ? err.message : String(err));
      }
    },
    [state.db, refresh, busy],
  );

  const quit = useCallback(() => {
    abortRef.current?.abort();
    renderer.destroy();
    process.exit(0);
  }, [renderer]);

  const goToView = useCallback(
    (next: View) => {
      if (busy) return;
      setView(next);
      setFocus(next === "query" || next === "add" ? "input" : "main");
    },
    [busy],
  );

  useKeyboard((key) => {
    // Classic OS copy: Cmd+C on macOS, Ctrl+C on Windows/Linux.
    if (isClassicCopyShortcut(key)) {
      const hasSelection = Boolean(selectionTextRef.current.trimEnd());
      // On non-macOS, Ctrl+C copies when text is selected; otherwise it quits.
      if (hasSelection || process.platform === "darwin") {
        void copySelection();
        return;
      }
      quit();
      return;
    }
    if (isQuitCtrlC(key)) {
      quit();
      return;
    }
    if (key.name === "escape") {
      if (busy) {
        cancelWork();
        return;
      }
      setFocus("main");
      return;
    }

    if (busy) return;

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
      if (key.name === "u" && !key.shift) {
        const src = state.sources[sourceCursor];
        if (src) void runUpdate([src.root_uri], src.title || src.root_uri);
      }
      if ((key.name === "u" && key.shift) || key.name === "U") {
        if (state.sources.length > 0) {
          void runUpdate(
            state.sources.map((s) => s.root_uri),
            `all ${state.sources.length} sources`,
          );
        }
      }
      if (key.name === "i" || key.name === "I") {
        if (state.sources.length > 0) {
          void runReembed(`all ${state.sources.length} sources`);
        }
      }
      if (key.name === "d" || key.name === "x") {
        const src = state.sources[sourceCursor];
        if (src) void runRemove(src);
      }
    }
  });

  const selected = state.sources[sourceCursor] ?? null;
  const inputFocused = focus === "input" && !busy;

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
            onMouseDown={() => {
              if (!busy) void refresh();
            }}
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
              <box width="45%" height="100%" flexDirection="column" gap={1}>
                <box flexDirection="row" width="100%" gap={1}>
                  <ActionButton
                    flexGrow={1}
                    label="U update all"
                    borderColor={hoveredNav === "update-all" ? COLORS.accent : COLORS.border}
                    backgroundColor={hoveredNav === "update-all" ? COLORS.border : COLORS.panel}
                    fg={
                      state.sources.length === 0 || busy
                        ? COLORS.muted
                        : hoveredNav === "update-all"
                          ? COLORS.text
                          : COLORS.accent
                    }
                    onMouseDown={() => {
                      if (!busy && state.sources.length > 0) {
                        void runUpdate(
                          state.sources.map((s) => s.root_uri),
                          `all ${state.sources.length} sources`,
                        );
                      }
                    }}
                    onMouseOver={() => setHoveredNav("update-all")}
                    onMouseOut={() => setHoveredNav((h) => (h === "update-all" ? null : h))}
                  />
                  <ActionButton
                    flexGrow={1}
                    label="I re-embed all"
                    borderColor={hoveredNav === "reindex-all" ? COLORS.yellow : COLORS.border}
                    backgroundColor={hoveredNav === "reindex-all" ? COLORS.border : COLORS.panel}
                    fg={
                      state.sources.length === 0 || busy
                        ? COLORS.muted
                        : hoveredNav === "reindex-all"
                          ? COLORS.text
                          : COLORS.yellow
                    }
                    onMouseDown={() => {
                      if (!busy && state.sources.length > 0) {
                        void runReembed(`all ${state.sources.length} sources`);
                      }
                    }}
                    onMouseOver={() => setHoveredNav("reindex-all")}
                    onMouseOut={() => setHoveredNav((h) => (h === "reindex-all" ? null : h))}
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
                        <text fg={COLORS.muted}>{displayPath(s.root_uri, 48)}</text>
                      </box>
                    ))
                  )}
                </scrollbox>
              </box>
              <box
                flexGrow={1}
                height="100%"
                border
                borderColor={COLORS.border}
                padding={1}
                flexDirection="column"
                title="Detail"
                titleColor={COLORS.muted}
                gap={1}
              >
                {selected ? (
                  <box flexShrink={0} flexDirection="column" width="100%" gap={0}>
                    <text fg={COLORS.accent}>
                      {displayPath(selected.title || selected.root_uri || selected.id)}
                    </text>
                    <text fg={COLORS.muted}>id: {selected.id}</text>
                    <text fg={COLORS.muted}>kind: {selected.kind}</text>
                    <text fg={COLORS.muted}>status: {selected.status}</text>
                    <text fg={COLORS.muted}>strategy: {selected.strategy ?? "—"}</text>
                    <text fg={COLORS.text}>{displayPath(selected.root_uri, 72)}</text>
                    <text fg={COLORS.muted}>updated: {selected.updated_at}</text>
                  </box>
                ) : (
                  <text fg={COLORS.muted}>Select a source (j/k or ↑/↓)</text>
                )}

                <box flexShrink={0} flexDirection="row" gap={1} marginTop={1}>
                  <ActionButton
                    label="u update"
                    borderColor={hoveredNav === "update" ? COLORS.accent : COLORS.border}
                    backgroundColor={hoveredNav === "update" ? COLORS.border : undefined}
                    fg={
                      !selected || busy
                        ? COLORS.muted
                        : hoveredNav === "update"
                          ? COLORS.text
                          : COLORS.accent
                    }
                    onMouseDown={() => {
                      if (!busy && selected) {
                        void runUpdate([selected.root_uri], selected.title || selected.root_uri);
                      }
                    }}
                    onMouseOver={() => setHoveredNav("update")}
                    onMouseOut={() => setHoveredNav((h) => (h === "update" ? null : h))}
                  />
                  <ActionButton
                    label="d remove"
                    borderColor={hoveredNav === "remove" ? COLORS.red : COLORS.border}
                    backgroundColor={hoveredNav === "remove" ? COLORS.border : undefined}
                    fg={
                      !selected || busy
                        ? COLORS.muted
                        : hoveredNav === "remove"
                          ? COLORS.text
                          : COLORS.red
                    }
                    onMouseDown={() => {
                      if (!busy && selected) void runRemove(selected);
                    }}
                    onMouseOver={() => setHoveredNav("remove")}
                    onMouseOut={() => setHoveredNav((h) => (h === "remove" ? null : h))}
                  />
                  {updating && (
                    <ActionButton
                      label="Cancel"
                      borderColor={hoveredNav === "cancel" ? COLORS.red : COLORS.border}
                      backgroundColor={hoveredNav === "cancel" ? COLORS.border : undefined}
                      fg={COLORS.red}
                      onMouseDown={() => cancelWork()}
                      onMouseOver={() => setHoveredNav("cancel")}
                      onMouseOut={() => setHoveredNav((h) => (h === "cancel" ? null : h))}
                    />
                  )}
                </box>

                {(updating || updateLog) && (
                  <scrollbox
                    width="100%"
                    flexGrow={1}
                    stickyScroll
                    stickyStart="bottom"
                    viewportCulling={false}
                    style={{
                      rootOptions: { backgroundColor: COLORS.panel },
                      contentOptions: { backgroundColor: COLORS.panel },
                    }}
                  >
                    {(updateLog || "Working…").split("\n").map((line, i) => (
                      <box key={`upd-${i}`} width="100%" height={1} flexShrink={0}>
                        <text
                          selectable
                          selectionBg={COLORS.selectionBg}
                          selectionFg={COLORS.selectionFg}
                          fg={
                            updating
                              ? COLORS.yellow
                              : line.startsWith("Done") || line.startsWith("Removed")
                                ? COLORS.green
                                : COLORS.text
                          }
                        >
                          {line || " "}
                        </text>
                      </box>
                    ))}
                  </scrollbox>
                )}

                {!updating && !updateLog && (
                  <text fg={COLORS.muted}>
                    u update · d remove · U update all · I re-embed all (embeddings only)
                  </text>
                )}
              </box>
            </box>
          )}

          {view === "query" && (
            <box flexDirection="column" width="100%" height="100%" gap={1}>
              <box width="100%" flexDirection="row" gap={1} height={3}>
                <box
                  flexGrow={1}
                  height={3}
                  border
                  borderColor={inputFocused ? COLORS.accent : COLORS.border}
                  title={busy ? "Query (busy)" : "Query"}
                  titleColor={busy ? COLORS.muted : COLORS.accent}
                >
                  <input
                    placeholder="Search indexed docs…"
                    focused={inputFocused}
                    value={query}
                    onInput={(v: string) => {
                      if (!busy) setQuery(v);
                    }}
                    onSubmit={() => {
                      if (!busy) void runQuery(query);
                    }}
                  />
                </box>
                {busy && (
                  <ActionButton
                    width={12}
                    label="Cancel"
                    borderColor={hoveredNav === "cancel" ? COLORS.red : COLORS.border}
                    backgroundColor={hoveredNav === "cancel" ? COLORS.border : COLORS.panel}
                    fg={COLORS.red}
                    onMouseDown={() => cancelWork()}
                    onMouseOver={() => setHoveredNav("cancel")}
                    onMouseOut={() => setHoveredNav((h) => (h === "cancel" ? null : h))}
                  />
                )}
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
                  <text fg={COLORS.yellow}>Searching… (Esc / Cancel to stop)</text>
                ) : result ? (
                  result.split("\n").map((line, i) => (
                    <box key={`line-${i}`} width="100%" height={1} flexShrink={0}>
                      <text
                        selectable
                        selectionBg={COLORS.selectionBg}
                        selectionFg={COLORS.selectionFg}
                        fg={COLORS.text}
                      >
                        {line || " "}
                      </text>
                    </box>
                  ))
                ) : (
                  <text fg={COLORS.muted}>
                    Type a query and press Enter. Drag to select · {COPY_KEY} to copy.
                  </text>
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
              <text fg={COLORS.muted}>proxy: {state.loaded?.config.http.proxy.url ?? "none"}</text>
              <text fg={COLORS.muted}>
                proxy ignore:{" "}
                {state.loaded?.config.http.proxy.ignore.length
                  ? state.loaded.config.http.proxy.ignore.join(", ")
                  : "—"}
              </text>
              <text fg={COLORS.muted}>
                tls verify:{" "}
                {state.loaded?.config.http.proxy.reject_unauthorized === false ? "off" : "on"}
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
              <box width="100%" flexDirection="row" gap={1} height={3}>
                <box
                  flexGrow={1}
                  height={3}
                  border
                  borderColor={inputFocused ? COLORS.accent : COLORS.border}
                  title={busy ? "Add (busy)" : "URL · GitHub · folder"}
                  titleColor={busy ? COLORS.muted : COLORS.accent}
                >
                  <input
                    placeholder="https://docs…  |  github.com/org/repo  |  ./docs"
                    focused={inputFocused}
                    value={addTarget}
                    onInput={(v: string) => {
                      if (!busy) setAddTarget(v);
                    }}
                    onSubmit={() => {
                      if (!busy) void runAdd(addTarget);
                    }}
                  />
                </box>
                {busy && (
                  <ActionButton
                    width={12}
                    label="Cancel"
                    borderColor={hoveredNav === "cancel" ? COLORS.red : COLORS.border}
                    backgroundColor={hoveredNav === "cancel" ? COLORS.border : COLORS.panel}
                    fg={COLORS.red}
                    onMouseDown={() => cancelWork()}
                    onMouseOver={() => setHoveredNav("cancel")}
                    onMouseOut={() => setHoveredNav((h) => (h === "cancel" ? null : h))}
                  />
                )}
              </box>
              <scrollbox
                width="100%"
                flexGrow={1}
                stickyScroll
                stickyStart="bottom"
                viewportCulling={false}
                style={{
                  rootOptions: { backgroundColor: COLORS.panel },
                  contentOptions: { backgroundColor: COLORS.panel },
                }}
              >
                {adding || addLog ? (
                  (addLog || "Working…").split("\n").map((line, i) => (
                    <box key={`add-${i}`} width="100%" height={1} flexShrink={0}>
                      <text
                        selectable
                        selectionBg={COLORS.selectionBg}
                        selectionFg={COLORS.selectionFg}
                        fg={
                          adding
                            ? i === 0 || line.startsWith("[")
                              ? COLORS.yellow
                              : COLORS.muted
                            : line.startsWith("Done")
                              ? COLORS.green
                              : line.startsWith("  ")
                                ? COLORS.muted
                                : COLORS.text
                        }
                      >
                        {line || " "}
                      </text>
                    </box>
                  ))
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
        <text fg={statusFlash ? COLORS.green : COLORS.muted}>
          {statusFlash
            ? statusFlash
            : busy
              ? `busy · Esc / Cancel · drag select · ${COPY_KEY} copy`
              : `click sidebar · 1–4 views · ↑↓/jk · drag select · ${COPY_KEY} copy · ${QUIT_KEYS} quit · query=${
                  query ? `"${query.slice(0, 40)}"` : "—"
                }${addTarget && view === "add" ? ` · add="${addTarget.slice(0, 40)}"` : ""}`}
        </text>
      </box>
    </box>
  );
}

export async function startTui(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
    enableMouseMovement: true,
    // So Cmd (`super`) modifiers reach the app on macOS (needed for Cmd+C copy).
    useKittyKeyboard: {},
    targetFps: 30,
  });
  createRoot(renderer).render(<App />);
  await new Promise<void>(() => {
    // OpenTUI keeps the process alive until renderer.destroy() / process.exit
  });
}
