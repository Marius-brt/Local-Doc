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

## Install

### Binary (recommended)

[`install.sh`](install.sh) detects OS/CPU, fetches the latest [GitHub Release](https://github.com/Marius-brt/Local-Doc/releases), and installs to `~/.local/bin/localdoc`.

Requires `curl` plus `jq` or `python3`.

```bash
curl -fsSL https://raw.githubusercontent.com/Marius-brt/Local-Doc/main/install.sh | bash
```

Re-run the same command to upgrade. Options:

```bash
# Pin a release tag
LOCALDOC_VERSION=v0.1.0 bash install.sh

# Custom install location
PREFIX=/usr/local/bin bash install.sh

# Alpine / musl (auto-detected; override if needed)
LOCALDOC_LIBC=musl bash install.sh
```

Published assets: `localdoc-darwin-arm64`, `localdoc-linux-x64`, `localdoc-linux-x64-musl`, `localdoc-windows-x64.exe`.

On Windows, download `localdoc-windows-x64.exe` from [Releases](https://github.com/Marius-brt/Local-Doc/releases) and put it on your `PATH`.

### From source (dev)

```bash
bun install
bun run localdoc doctor
```

## Config

Default path: `~/.config/localdoc/config.yml`  
Created automatically on first run with defaults. Override with `--config` or `LOCALDOC_CONFIG`.

Data directory (from `data_dir`): `~/.localdoc/` — `index.db`, `models/`, `extracted/`, `browsers/`, `bin/`.

```yaml
# ~/.config/localdoc/config.yml

data_dir: ~/.localdoc

embeddings:
  # Local default (embedded Model2Vec sidecar)
  provider: model2vec          # model2vec | openai_compatible
  model: minishlab/potion-base-8M
  # openai_compatible:
  #   base_url: https://api.openai.com/v1
  #   api_key_env: OPENAI_API_KEY
  #   model: text-embedding-3-small

rerank:
  enabled: false
  provider: none               # none | local | cohere
  model: null
  # cohere:
  #   api_key_env: COHERE_API_KEY

search:
  rrf_k: 60                    # RRF fusion constant
  fts_limit: 40                # FTS candidates before fusion
  vector_limit: 40             # vector candidates before fusion
  top_k: 12                    # results returned after fusion/rerank
  budget_tokens: 2400          # context-pack token budget

chunking:
  chunk_size: 512
  min_characters: 24
  table_rows: 3

crawl:
  max_pages: 500
  concurrency: 4
  timeout_ms: 30000
  playwright: auto             # auto | always | never
  respect_robots: true
  headers: {}

http:
  proxy: null                  # one proxy for http:// and https://
  headers: {}
  retries: 3
  reject_unauthorized: true    # false = skip TLS verify (insecure)
```

| Section | Purpose |
| --- | --- |
| `data_dir` | Index DB, downloaded models, extracted pages, Playwright browsers |
| `embeddings` | Vector embeddings — local Model2Vec by default, or any OpenAI-compatible API |
| `rerank` | Optional second-pass ranking (`local` via Transformers.js, or Cohere) |
| `search` | Hybrid FTS + vector fusion and context budget |
| `chunking` | How ingested markdown is split |
| `crawl` | Web ingest limits, Playwright policy, crawl headers |
| `http` | Shared HTTP client: proxy, TLS, retries, headers |

### Proxy & TLS

Set a single `http.proxy` — Bun routes both **http://** and **https://** targets through it (same for Playwright browser fallback).

```yaml
http:
  proxy: http://127.0.0.1:7890
  # proxy: http://user:pass@proxy.example.com:8080
  # proxy: socks5://127.0.0.1:1080

  # Corporate / self-signed MITM proxies:
  reject_unauthorized: false
```

Leave `proxy: null` for direct connections. `reject_unauthorized: false` disables certificate verification (insecure — only when you trust the network path).

Changing `embeddings.model` (or provider) after you already indexed may require re-ingesting so vector dimensions stay consistent.

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

Keys: `1–4` switch views · `j/k` or arrows browse sources · `u` update selected · `U` update all · Enter submit · Esc / **Cancel** stops a running query or ingest · `r` refresh · `q` / Ctrl+C quit.

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

Artifacts land in `dist/`. GitHub Actions (`.github/workflows/release.yml`) builds on version tags for macOS (arm64), Linux (glibc + musl), and Windows.

**Notes on the standalone binary:**

- TUI (OpenTUI) launches when the binary is run with no args on a TTY (`./localdoc-darwin-arm64`).
- Default embeddings use the embedded Model2Vec sidecar ([`model2vec`](https://docs.rs/model2vec/latest/model2vec/) crate) with `minishlab/potion-base-8M` (downloaded once into `~/.localdoc/models/model2vec/`).
- Transformers.js + ONNX Runtime natives are bundled for local rerank (`rerank.provider: local`).
- Playwright is not bundled — browser crawl downloads Chromium on first need when running via Bun; set `crawl.playwright: never` to disable.

## License

MIT
