import { describe, expect, test } from "bun:test";
import { normalizeOpenAICompatibleBaseUrl } from "../src/util/openai-url.ts";

describe("normalizeOpenAICompatibleBaseUrl", () => {
  test("appends /v1 to host-only URLs", () => {
    expect(normalizeOpenAICompatibleBaseUrl("http://127.0.0.1:1234")).toBe(
      "http://127.0.0.1:1234/v1",
    );
    expect(normalizeOpenAICompatibleBaseUrl("http://127.0.0.1:1234/")).toBe(
      "http://127.0.0.1:1234/v1",
    );
  });

  test("leaves paths that already include /v1", () => {
    expect(normalizeOpenAICompatibleBaseUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1",
    );
    expect(normalizeOpenAICompatibleBaseUrl("http://127.0.0.1:1234/v1/")).toBe(
      "http://127.0.0.1:1234/v1",
    );
  });

  test("leaves custom API path prefixes alone", () => {
    expect(normalizeOpenAICompatibleBaseUrl("http://proxy.example/openai")).toBe(
      "http://proxy.example/openai",
    );
  });
});
