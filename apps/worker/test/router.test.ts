import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const call = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`https://magpie.test${path}`, init));
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("router", () => {
  it("serves /health without auth", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("authorizes the ingest token", async () => {
    const res = await call("/ingest", { method: "POST", headers: bearer("test-ingest-token") });
    expect(res.status).toBe(400);
  });

  it("rejects /ingest without a token", async () => {
    expect((await call("/ingest", { method: "POST" })).status).toBe(401);
  });

  it("rejects /ingest with a wrong token", async () => {
    expect((await call("/ingest", { method: "POST", headers: bearer("nope") })).status).toBe(401);
  });

  it("does not accept the MCP token on /ingest", async () => {
    expect((await call("/ingest", { method: "POST", headers: bearer("test-mcp-token") })).status).toBe(401);
  });

  it("does not accept the ingest token on /mcp", async () => {
    expect((await call("/mcp", { method: "POST", headers: bearer("test-ingest-token") })).status).toBe(401);
  });

  it("rejects GET /ingest", async () => {
    expect((await call("/ingest", { headers: bearer("test-ingest-token") })).status).toBe(405);
  });

  it("404s unknown paths", async () => {
    expect((await call("/nope")).status).toBe(404);
  });
});
