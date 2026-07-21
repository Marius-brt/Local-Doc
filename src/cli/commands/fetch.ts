import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { defineCommand } from "citty";
import pLimit from "p-limit";
import { extractPage } from "../../crawl/adapters/index.ts";
import { discoverUrls } from "../../crawl/discover.ts";
import { fetchText } from "../../crawl/fetch.ts";
import { isUnderRoot, normalizeUrl } from "../../crawl/urls.ts";
import { shortId } from "../../util/hash.ts";
import { createCtx } from "../context.ts";

export default defineCommand({
  meta: {
    name: "fetch",
    description: "Download docs to markdown without indexing",
  },
  args: {
    url: { type: "positional", description: "Documentation URL", required: true },
    output: {
      type: "string",
      description: "Output directory",
      alias: "o",
      required: true,
    },
    config: { type: "string", description: "Path to config.yml", alias: "c" },
  },
  async run({ args }) {
    const ctx = await createCtx(args.config);
    const outDir = String(args.output);
    await mkdir(outDir, { recursive: true });

    const rootUrl = String(args.url);
    const discovery = await discoverUrls(rootUrl, ctx.loaded.config);
    console.log(`Fetching ${discovery.urls.length} pages via ${discovery.strategy} → ${outDir}`);

    const limit = pLimit(ctx.loaded.config.crawl.concurrency);
    let ok = 0;
    await Promise.all(
      discovery.urls.map((url) =>
        limit(async () => {
          const res = await fetchText(url, ctx.loaded.config, undefined, {
            mode: "under-root",
            root: rootUrl,
          });
          if (!res.ok) return;
          let finalUrl = res.url;
          try {
            finalUrl = normalizeUrl(res.url);
          } catch {
            return;
          }
          if (!isUnderRoot(finalUrl, rootUrl)) return;
          let markdown = res.body;
          let title = url;
          if (!url.endsWith(".txt") && res.contentType.includes("html")) {
            const extracted = extractPage(res.body, finalUrl);
            markdown = extracted.markdown;
            title = extracted.title;
          }
          const file = join(outDir, `${shortId(finalUrl)}.md`);
          await writeFile(
            file,
            `---\ntitle: ${JSON.stringify(title)}\nsource: ${finalUrl}\n---\n\n${markdown}\n`,
            "utf8",
          );
          ok++;
        }),
      ),
    );
    console.log(chalk.green(`Wrote ${ok} files to ${outDir}`));
  },
});
