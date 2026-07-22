import { parse as parseYaml } from "yaml";

/** Loose OpenAPI / Swagger document (2.0 or 3.x). */
export interface OpenApiDoc {
  openapi?: string;
  swagger?: string;
  info?: {
    title?: string;
    description?: string;
    version?: string;
    termsOfService?: string;
    contact?: { name?: string; url?: string; email?: string };
    license?: { name?: string; url?: string };
  };
  servers?: Array<{ url?: string; description?: string }>;
  host?: string;
  basePath?: string;
  schemes?: string[];
  tags?: Array<{ name?: string; description?: string }>;
  paths?: Record<string, PathItem | undefined>;
  components?: {
    schemas?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
    requestBodies?: Record<string, unknown>;
    responses?: Record<string, unknown>;
  };
  definitions?: Record<string, unknown>;
  security?: unknown[];
}

type PathItem = Record<string, unknown> & {
  parameters?: unknown[];
  summary?: string;
  description?: string;
};

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

/**
 * True when the URL path looks like an OpenAPI / Swagger document endpoint.
 */
export function looksLikeOpenApiUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "") || "/";
    if (/(^|\/)(openapi|swagger)(\.(json|ya?ml))?$/i.test(path)) return true;
    if (/\.(json|ya?ml)$/i.test(path) && /(openapi|swagger)/i.test(path)) return true;
    // Common API-doc paths without extension (Springdoc, Redocly, etc.)
    if (/\/(v\d+\/)?(openapi|swagger)(\/|$)/i.test(path)) return true;
    if (/\/(api-docs|v3\/api-docs)(\.json)?$/i.test(path)) return true;
    return false;
  } catch {
    return /(openapi|swagger)\.(json|ya?ml)/i.test(url);
  }
}

/** Parse JSON or YAML text into a value. */
export function parseOpenApiText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Empty OpenAPI document");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  return parseYaml(trimmed);
}

/** True if the parsed value looks like OpenAPI 3.x or Swagger 2.0. */
export function isOpenApiDocument(value: unknown): value is OpenApiDoc {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  if (typeof o.openapi === "string" && o.openapi.length > 0) return true;
  if (o.swagger === "2.0" || o.swagger === "2.0.0") return true;
  // Heuristic: paths object + info
  if (
    o.paths &&
    typeof o.paths === "object" &&
    !Array.isArray(o.paths) &&
    o.info &&
    typeof o.info === "object"
  ) {
    return true;
  }
  return false;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

function esc(s: string): string {
  return s.replace(/\r\n/g, "\n").trim();
}

function schemaToJson(schema: unknown, indent = 2): string {
  try {
    return JSON.stringify(schema ?? {}, null, indent);
  } catch {
    return String(schema);
  }
}

function paramRows(params: unknown[]): string {
  if (!params.length) return "";
  const lines = [
    "| name | in | required | type | description |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const p of params) {
    const r = asRecord(p);
    if (!r) continue;
    if (typeof r.$ref === "string") {
      lines.push(`| \`${String(r.$ref).split("/").pop()}\` | — | — | $ref | \`${r.$ref}\` |`);
      continue;
    }
    const schema = asRecord(r.schema) ?? {};
    const type =
      (typeof schema.type === "string" ? schema.type : null) ||
      (typeof r.type === "string" ? r.type : null) ||
      (typeof r.$ref === "string" ? "$ref" : "—");
    const name = String(r.name ?? "—");
    const inn = String(r.in ?? "—");
    const req = r.required === true ? "yes" : "no";
    const desc = esc(String(r.description ?? ""))
      .replace(/\|/g, "\\|")
      .replace(/\n+/g, " ");
    lines.push(`| \`${name}\` | ${inn} | ${req} | ${type} | ${desc || "—"} |`);
  }
  return `${lines.join("\n")}\n`;
}

function collectParams(op: Record<string, unknown>, pathItem: PathItem): unknown[] {
  const out: unknown[] = [];
  if (Array.isArray(pathItem.parameters)) out.push(...pathItem.parameters);
  if (Array.isArray(op.parameters)) out.push(...op.parameters);
  return out;
}

function renderRequestBody(op: Record<string, unknown>): string {
  const parts: string[] = [];
  const rb = asRecord(op.requestBody);
  if (rb) {
    parts.push("#### Request body");
    if (typeof rb.description === "string" && rb.description.trim()) {
      parts.push(esc(rb.description), "");
    }
    if (rb.required === true) parts.push("Required: yes", "");
    const content = asRecord(rb.content);
    if (content) {
      for (const [ct, media] of Object.entries(content)) {
        parts.push(`##### Content-Type: \`${ct}\``);
        const m = asRecord(media);
        if (m?.schema) {
          parts.push("```json", schemaToJson(m.schema), "```", "");
        }
        if (m?.example != null) {
          parts.push("Example:", "```json", schemaToJson(m.example), "```", "");
        }
      }
    }
    return parts.join("\n");
  }
  // Swagger 2 body / form params already in parameters table
  return "";
}

function renderResponses(op: Record<string, unknown>): string {
  const responses = asRecord(op.responses);
  if (!responses) return "";
  const parts: string[] = ["#### Responses", ""];
  for (const [code, resp] of Object.entries(responses)) {
    parts.push(`##### ${code}`);
    if (typeof resp === "string") {
      parts.push(esc(resp), "");
      continue;
    }
    const r = asRecord(resp);
    if (!r) continue;
    if (typeof r.$ref === "string") {
      parts.push(`$ref: \`${r.$ref}\``, "");
      continue;
    }
    if (typeof r.description === "string" && r.description.trim()) {
      parts.push(esc(r.description), "");
    }
    const content = asRecord(r.content);
    if (content) {
      for (const [ct, media] of Object.entries(content)) {
        const m = asRecord(media);
        if (m?.schema) {
          parts.push(`\`${ct}\`:`, "```json", schemaToJson(m.schema), "```", "");
        }
      }
    } else if (r.schema) {
      parts.push("```json", schemaToJson(r.schema), "```", "");
    }
  }
  return parts.join("\n");
}

/**
 * Convert an OpenAPI / Swagger document into heading-structured markdown
 * suitable for localdoc chunking (prose / tables / fenced JSON).
 */
export function openApiToMarkdown(doc: OpenApiDoc): {
  title: string;
  markdown: string;
  version: string | null;
} {
  const title = esc(doc.info?.title || "API");
  const version = doc.info?.version ? esc(doc.info.version) : null;
  const specVer = doc.openapi
    ? `OpenAPI ${doc.openapi}`
    : doc.swagger
      ? `Swagger ${doc.swagger}`
      : "OpenAPI";

  const lines: string[] = [];
  lines.push(`# ${title}${version ? ` ${version}` : ""}`);
  lines.push("");
  lines.push(`_${specVer}_`);
  lines.push("");

  if (doc.info?.description) {
    lines.push(esc(doc.info.description), "");
  }

  if (doc.servers?.length) {
    lines.push("## Servers", "");
    for (const s of doc.servers) {
      const url = s.url ?? "";
      const desc = s.description ? ` — ${esc(s.description)}` : "";
      lines.push(`- \`${url}\`${desc}`);
    }
    lines.push("");
  } else if (doc.host) {
    const schemes = doc.schemes?.length ? doc.schemes : ["https"];
    lines.push("## Servers", "");
    for (const sch of schemes) {
      lines.push(`- \`${sch}://${doc.host}${doc.basePath ?? ""}\``);
    }
    lines.push("");
  }

  if (doc.tags?.length) {
    lines.push("## Tags", "");
    for (const t of doc.tags) {
      if (!t?.name) continue;
      lines.push(`### ${esc(t.name)}`);
      if (t.description) lines.push(esc(t.description), "");
      else lines.push("");
    }
  }

  const paths = doc.paths ?? {};
  const pathKeys = Object.keys(paths).sort();
  if (pathKeys.length) {
    lines.push("## Paths", "");
    for (const path of pathKeys) {
      const item = paths[path];
      if (!item || typeof item !== "object") continue;
      const pathItem = item as PathItem;
      lines.push(`### \`${path}\``);
      if (pathItem.summary) lines.push(esc(pathItem.summary), "");
      if (pathItem.description) lines.push(esc(pathItem.description), "");

      for (const method of Object.keys(pathItem)) {
        if (!HTTP_METHODS.has(method)) continue;
        const op = asRecord(pathItem[method]);
        if (!op) continue;
        const opId = typeof op.operationId === "string" ? op.operationId : null;
        const summary = typeof op.summary === "string" ? esc(op.summary) : "";
        lines.push(`#### ${method.toUpperCase()} ${path}${opId ? ` — \`${opId}\`` : ""}`);
        if (summary) lines.push(summary, "");
        if (typeof op.description === "string" && op.description.trim()) {
          lines.push(esc(op.description), "");
        }
        if (Array.isArray(op.tags) && op.tags.length) {
          lines.push(`Tags: ${op.tags.map((t) => `\`${String(t)}\``).join(", ")}`, "");
        }

        const params = collectParams(op, pathItem);
        if (params.length) {
          lines.push("##### Parameters", "", paramRows(params));
        }

        const body = renderRequestBody(op);
        if (body) lines.push(body);

        const responses = renderResponses(op);
        if (responses) lines.push(responses);

        if (op.deprecated === true) lines.push("_Deprecated._", "");
        lines.push("");
      }
    }
  }

  const schemas = doc.components?.schemas ?? doc.definitions;
  if (schemas && typeof schemas === "object") {
    lines.push("## Schemas", "");
    for (const name of Object.keys(schemas).sort()) {
      lines.push(`### ${name}`, "");
      lines.push("```json", schemaToJson(schemas[name]), "```", "");
    }
  }

  return {
    title,
    markdown: `${lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()}\n`,
    version,
  };
}
