import { describe, expect, test } from "bun:test";
import {
  isOpenApiDocument,
  looksLikeOpenApiUrl,
  openApiToMarkdown,
  parseOpenApiText,
} from "../src/extract/openapi.ts";

const MINIMAL_OAS3 = {
  openapi: "3.0.3",
  info: {
    title: "Petstore",
    version: "1.0.0",
    description: "A sample Petstore API.",
  },
  servers: [{ url: "https://petstore.example.com/v1" }],
  tags: [{ name: "pets", description: "Pet operations" }],
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        summary: "List all pets",
        tags: ["pets"],
        parameters: [
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer" },
            description: "Max pets to return",
          },
        ],
        responses: {
          "200": {
            description: "A pet list",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Pet" },
                },
              },
            },
          },
        },
      },
      post: {
        operationId: "createPet",
        summary: "Create a pet",
        tags: ["pets"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Pet" },
            },
          },
        },
        responses: {
          "201": { description: "Created" },
        },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: "object",
        required: ["name"],
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
        },
      },
    },
  },
};

describe("looksLikeOpenApiUrl", () => {
  test("matches common openapi/swagger paths", () => {
    expect(looksLikeOpenApiUrl("https://api.example.com/openapi.json")).toBe(true);
    expect(looksLikeOpenApiUrl("https://api.example.com/openapi.yaml")).toBe(true);
    expect(looksLikeOpenApiUrl("https://api.example.com/swagger.json")).toBe(true);
    expect(looksLikeOpenApiUrl("https://api.example.com/v3/api-docs")).toBe(true);
    expect(looksLikeOpenApiUrl("https://api.example.com/docs/openapi.yml")).toBe(true);
  });

  test("rejects normal doc pages", () => {
    expect(looksLikeOpenApiUrl("https://docs.example.com/guide")).toBe(false);
    expect(looksLikeOpenApiUrl("https://docs.example.com/llms-full.txt")).toBe(false);
  });
});

describe("parse + detect OpenAPI", () => {
  test("parses JSON and detects OAS3", () => {
    const parsed = parseOpenApiText(JSON.stringify(MINIMAL_OAS3));
    expect(isOpenApiDocument(parsed)).toBe(true);
  });

  test("parses YAML swagger 2", () => {
    const yaml = `
swagger: "2.0"
info:
  title: Legacy
  version: "2"
paths:
  /health:
    get:
      summary: Health
      responses:
        200:
          description: ok
`;
    const parsed = parseOpenApiText(yaml);
    expect(isOpenApiDocument(parsed)).toBe(true);
  });

  test("rejects unrelated JSON", () => {
    expect(isOpenApiDocument({ foo: 1 })).toBe(false);
    expect(isOpenApiDocument([])).toBe(false);
  });
});

describe("openApiToMarkdown", () => {
  test("emits title, paths, parameters table, schemas", () => {
    const { title, markdown, version } = openApiToMarkdown(MINIMAL_OAS3);
    expect(title).toBe("Petstore");
    expect(version).toBe("1.0.0");
    expect(markdown).toContain("# Petstore 1.0.0");
    expect(markdown).toContain("## Paths");
    expect(markdown).toContain("#### GET /pets");
    expect(markdown).toContain("listPets");
    expect(markdown).toContain("| name | in | required | type | description |");
    expect(markdown).toContain("`limit`");
    expect(markdown).toContain("#### Request body");
    expect(markdown).toContain("## Schemas");
    expect(markdown).toContain("### Pet");
    expect(markdown).toContain("```json");
  });
});
