# localdoc

Offline-first documentation index for AI agents.

Index docs from **websites**, **GitHub repos**, and **local folders** into a local libSQL database. Query them as compact context packs via **CLI**, **TUI**, or **MCP**.

MIT licensed. Single-file executables via Bun.

## Features

- Smart web crawl: `llms-full.txt` → `llms.txt` → sitemap → nav crawl
- Site adapters (Mintlify, GitBook, Docusaurus, ReadMe, Sphinx) + boilerplate stripping
- Hybrid search: FTS5 (BM25) + vectors, fused with RRF; optional Cohere (`@ai-sdk/cohere`) / local rerank
- Default local embeddings via embedded Model2Vec Rust sidecar (`minishlab/potion-base-8M`); Transformers.js bundled for local rerank; OpenAI-compatible embeddings optional
- Prisma migrations for the schema (FTS triggers included in SQL migrations)
- Playwright auto-fallback for JS-heavy or blocked pages (downloaded on first use)
- Resumable ingest with content-hash skip and ingest reports

## Install (dev)

```bash
bun install
bun run localdoc doctor
```

## Config

Default path: `~/.config/localdoc/config.yml`  
Override: `--config` or `LOCALDOC_CONFIG`

Data directory: `~/.localdoc/` (`index.db`, `models/`, `extracted/`, `browsers/`)

## Commands

```bash
localdoc add https://docs.example.com
localdoc add https://github.com/owner/repo
localdoc add ./docs
localdoc update [source]
localdoc remove <source>
localdoc remove --all
localdoc list
localdoc list --all
localdoc query "how to authenticate"
localdoc query "…" --format json --limit 10 --budget 2400
localdoc inspect
localdoc doctor
localdoc fetch https://docs.example.com --output ./out
localdoc install-skill
localdoc install-skill -a cursor,claude-code,codex
localdoc mcp serve
localdoc tui
```

## TUI

Built with **[OpenTUI](https://opentui.com/)** (same stack as OpenCode): fullscreen layout, sidebar navigation, scrollable panels, and live ingest/query.

```bash
bun run localdoc tui
# or
bun run localdoc   # opens TUI when run with no args in a TTY
```

Keys: `1–4` switch views · `j/k` or arrows browse sources · Enter submit · `r` refresh · `q` / Ctrl+C quit.

## Agent skills

Yes — there is a standard CLI for this: **[`skills`](https://github.com/vercel-labs/skills)** (Vercel Labs). It installs `SKILL.md` files for Cursor, Claude Code, Codex, OpenCode, Antigravity, Gemini, Windsurf, and 60+ other agents.

`localdoc install-skill` uses that ecosystem when available (`bunx skills`), and falls back to writing `SKILL.md` into each agent’s skills directory:

| Agent | Flag | Global path |
| --- | --- | --- |
| Cursor | `cursor` | `~/.cursor/skills/localdoc/` |
| Claude Code | `claude-code` | `~/.claude/skills/localdoc/` |
| Codex | `codex` | `~/.codex/skills/localdoc/` |
| OpenCode | `opencode` | `~/.config/opencode/skills/localdoc/` |
| Antigravity | `antigravity` | `~/.gemini/antigravity/skills/localdoc/` |
| Open agents | `agents` | `~/.agents/skills/localdoc/` |

```bash
localdoc install-skill                          # default set
localdoc install-skill -a cursor,codex          # subset
localdoc install-skill --project                # project-local dirs
localdoc install-skill --no-skills-cli          # direct file write only
```

You can also install from the repo skill path:

```bash
bunx skills add ./skills -g -a cursor -a claude-code -a codex -y
```

## Database (Prisma)

Schema lives in [`prisma/schema.prisma`](prisma/schema.prisma). Migrations in [`prisma/migrations`](prisma/migrations) (including FTS5). Runtime applies them via libSQL without needing the Prisma CLI in the binary.

```bash
bun run db:migrate     # create/apply during development
bun run db:generate    # generate Prisma client
```

## Lint / format (Biome)

```bash
bun run lint
bun run lint:fix
bun run format
```

## MCP

```bash
localdoc mcp serve
```

Tools: `query`, `list`, `inspect`.

## Build executables

```bash
bun run build                 # all targets
bun run scripts/build.ts linux  # filter by name
```

Artifacts land in `dist/`. GitHub Actions (`.github/workflows/release.yml`) builds on version tags for macOS (arm64/x64), Linux (glibc + musl), and Windows.

**Notes on the standalone binary:**

- TUI (OpenTUI) launches when the binary is run with no args on a TTY (`./localdoc-darwin-arm64`).
- Default embeddings use the embedded Model2Vec sidecar ([`model2vec`](https://docs.rs/model2vec/latest/model2vec/) crate) with `minishlab/potion-base-8M` (downloaded once into `~/.localdoc/models/model2vec/`).
- Transformers.js + ONNX Runtime natives are bundled for local rerank (`rerank.provider: local`).
- Playwright is not bundled — browser crawl downloads Chromium on first need when running via Bun; set `crawl.playwright: never` to disable.

## License

MIT
