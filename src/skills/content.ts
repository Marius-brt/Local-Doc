export const SKILL_MARKDOWN = `---
name: localdoc
description: Search local documentation context packs with localdoc CLI. Use when the user asks about library docs, API references, vendor docs, version-specific behavior, offline docs, or wants to add docs before answering a technical question.
---

# localdoc

Compress documentation context so coding agents spend tokens on code, not on rereading raw docs. localdoc fetches docs from public sites, GitHub repos, and local folders, indexes them locally with libSQL (FTS + vectors), and returns compact context packs with source attribution.

**MIT open source.** Offline-first. Single executable.

## When to Use

- User asks about a third-party library, SDK, or API and you need accurate, up-to-date documentation.
- User references docs from a public site or GitHub repository.
- You need to verify version-specific API behavior or check exact method signatures.
- User asks to search or query previously ingested documentation.

## Workflow

1. Run \`localdoc list\` to see indexed docs.
2. Run \`localdoc query "question"\` when relevant docs are present.
3. If docs are missing and the user approves the source, run \`localdoc add <url-or-path>\` to index it locally.
4. Use the returned sections as source-grounded context for the answer or code change.

## Core commands

\`\`\`bash
localdoc add https://docs.example.com
localdoc add https://github.com/owner/repo
localdoc add ./docs
localdoc update
localdoc query "how to authenticate"
localdoc query "how to authenticate" --limit 10 --format json
localdoc query "auth flow" --kind code --source https://docs.example.com --keyword Bearer,token
localdoc list
localdoc inspect
localdoc remove <source>
localdoc doctor
localdoc mcp serve
\`\`\`

Optional query filters:

- \`--kind\` — chunk kinds: \`prose\`, \`table\`, \`code\` (aliases: \`text\`, \`markdown\`); comma-separated
- \`--source\` — source id(s) or root URI(s); comma-separated
- \`--keyword\` — terms that must appear in each chunk; comma-separated

## MCP

If configured, \`localdoc mcp serve\` exposes \`query\`, \`list\`, and \`inspect\` tools over stdio.
In OpenCode these appear as \`localdoc_query\`, \`localdoc_list\`, and \`localdoc_inspect\` — prefer them over shelling out when available.
MCP \`query\` accepts optional \`kinds\`, \`sources\`, and \`keywords\` arrays.

## Common mistakes

- Do not run \`localdoc query\` before adding a source with \`localdoc add\`. Check \`localdoc list\` first.
- Do not assume docs are indexed. Always verify with \`localdoc list\` before querying.
`;
