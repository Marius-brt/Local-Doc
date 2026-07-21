import { describe, expect, test } from "bun:test";
import { formatError, redactSecrets } from "../src/util/log.ts";

describe("log redaction", () => {
  test("redacts bearer tokens and api keys", () => {
    expect(redactSecrets("Authorization: Bearer sk-abc1234567890")).toContain("***");
    expect(redactSecrets("Authorization: Bearer sk-abc1234567890")).not.toContain("sk-abc");
    expect(redactSecrets('api_key="supersecretvalue"')).toContain("***");
    expect(redactSecrets("token=abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
  });

  test("formatError redacts response bodies with secrets", () => {
    const err = new Error("upstream failed") as Error & { responseBody?: string };
    err.responseBody = "Authorization: Bearer sk-proj-leakme123456";
    const out = formatError(err);
    expect(out).toContain("***");
    expect(out).not.toContain("sk-proj-leakme");
  });
});
