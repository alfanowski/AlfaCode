import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelsDevCatalogClient, ModelsDevCatalogError, toolCapableNonDeprecatedModels, type CatalogFetch } from "../src/models-dev-catalog.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true }))); });

async function cachePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "alfacode-models-dev-"));
  directories.push(directory);
  return join(directory, "catalog.json");
}

function catalog(providers: Record<string, unknown>): string { return JSON.stringify(providers); }

function provider(id: string, npm: string, models: Record<string, unknown>): Record<string, unknown> {
  return { id, name: `Provider ${id}`, npm, env: ["MODEL_API_KEY"], api: "https://provider.invalid/v1", doc: "https://provider.invalid/docs", models };
}

function model(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, name: `Model ${id}`, description: "catalog fixture", attachment: false, reasoning: false, tool_call: true,
    release_date: "2026-01-01", last_updated: "2026-01-01", modalities: { input: ["text"], output: ["text"] }, open_weights: false,
    limit: { context: 1000, output: 100 },
    ...overrides,
  };
}

function response(body: string, init: ResponseInit = {}): Response { return new Response(body, { status: 200, ...init }); }

describe("ModelsDevCatalogClient", () => {
  it("strictly accepts a 200 catalog, exposes metadata, and saves a private atomic cache", async () => {
    const path = await cachePath();
    let calls = 0;
    const fetch: CatalogFetch = async () => {
      calls += 1;
      return response(catalog({ compatible: provider("compatible", "@ai-sdk/openai-compatible", { "opaque-model": model("opaque-model", { reasoning: true, cost: { input: 1, output: 2, cache_read: 0.1 } }) }) }), { headers: { etag: "catalog-v1" } });
    };
    const client = new ModelsDevCatalogClient({ cachePath: path, fetch });

    const result = await client.load();
    const saved = await stat(path);

    const storedProvider = result.catalog.providers.get("compatible");
    expect(result).toMatchObject({ source: "network", stale: false });
    expect(storedProvider).toMatchObject({ id: "compatible", npm: "@ai-sdk/openai-compatible", env: ["MODEL_API_KEY"], api: "https://provider.invalid/v1" });
    expect(storedProvider?.models.get("opaque-model")).toMatchObject({ toolCall: true, reasoning: true, wireFamily: "openai-chat", limits: { context: 1000, output: 100 }, costs: { input: 1, output: 2, cacheRead: 0.1 } });
    expect(saved.mode & 0o077).toBe(0);
    expect((await stat(dirname(path))).mode & 0o077).toBe(0);
    expect(calls).toBe(1);
  });

  it("uses ETag revalidation and accepts 304 only with an existing stale cache", async () => {
    const path = await cachePath();
    let now = 1_000;
    const requests: RequestInit[] = [];
    const fetch: CatalogFetch = async (_input, init) => {
      requests.push(init ?? {});
      return requests.length === 1
        ? response(catalog({ source: provider("source", "@ai-sdk/openai-compatible", { alpha: model("alpha") }) }), { headers: { etag: "etag-1" } })
        : new Response(null, { status: 304 });
    };
    const client = new ModelsDevCatalogClient({ cachePath: path, fetch, clock: () => now, ttlMs: 10 });
    await client.load();
    now += 10;

    const result = await client.load();

    expect(result.source).toBe("not-modified");
    expect(new Headers(requests[1]?.headers).get("if-none-match")).toBe("etag-1");
  });

  it("rejects malformed and oversized responses without accepting partial catalog data", async () => {
    const malformedPath = await cachePath();
    const malformed = new ModelsDevCatalogClient({ cachePath: malformedPath, fetch: async () => response(catalog({ bad: { id: "bad" } })) });
    await expect(malformed.load()).rejects.toBeInstanceOf(ModelsDevCatalogError);

    const oversizedPath = await cachePath();
    const oversized = new ModelsDevCatalogClient({ cachePath: oversizedPath, maxPayloadBytes: 10, fetch: async () => response(catalog({ source: provider("source", "@ai-sdk/openai-compatible", { alpha: model("alpha") }) })) });
    await expect(oversized.load()).rejects.toBeInstanceOf(ModelsDevCatalogError);
  });

  it.each(["not-a-url", "http://provider.invalid/v1", "ftp://provider.invalid/v1", "${SOME_GATEWAY_BASE_URL}/v1"])("stores an untrusted provider API endpoint as opaque data without failing catalog parsing: %s", async (api) => {
    // The real upstream models.dev catalog legitimately contains provider entries like this
    // (local-gateway tools publish a loopback http:// URL; some publish an env-var template
    // string). One provider's freeform `api` field must never fail parsing for the whole
    // catalog — the actual safety judgment for pre-filling a suggested base URL happens
    // downstream in dynamicProviderDescriptors (see models-dev-runtime.test.ts), not here.
    const path = await cachePath();
    const untrusted = provider("untrusted", "@ai-sdk/openai-compatible", { alpha: model("alpha") });
    untrusted.api = api;
    const client = new ModelsDevCatalogClient({ cachePath: path, fetch: async () => response(catalog({ untrusted })) });

    const result = await client.load();

    expect(result.catalog.providers.get("untrusted")?.api).toBe(api);
  });

  it("accepts catalog providers without an optional API endpoint", async () => {
    const path = await cachePath();
    const withoutApi = provider("metadata-only", "@ai-sdk/openai-compatible", { alpha: model("alpha") });
    delete withoutApi.api;
    const result = await new ModelsDevCatalogClient({ cachePath: path, fetch: async () => response(catalog({ "metadata-only": withoutApi })) }).load();

    expect(result.catalog.providers.get("metadata-only")?.api).toBeUndefined();
  });

  it("falls back to a stale private cache when the live refresh is offline", async () => {
    const path = await cachePath();
    let now = 1_000;
    let online = true;
    const fetch: CatalogFetch = async () => {
      if (!online) throw new Error("offline");
      return response(catalog({ source: provider("source", "@ai-sdk/openai-compatible", { alpha: model("alpha") }) }));
    };
    const client = new ModelsDevCatalogClient({ cachePath: path, fetch, clock: () => now, ttlMs: 1 });
    await client.load();
    now += 1;
    online = false;

    const result = await client.load();

    expect(result).toMatchObject({ source: "stale-cache", stale: true });
    expect(result.catalog.providers.has("source")).toBe(true);
  });

  it("aborts a hung refresh at the configured timeout", async () => {
    const path = await cachePath();
    let aborted = false;
    const fetch: CatalogFetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(init.signal?.reason); }, { once: true });
    });
    const client = new ModelsDevCatalogClient({ cachePath: path, fetch, timeoutMs: 5 });

    await expect(client.load()).rejects.toBeInstanceOf(ModelsDevCatalogError);
    expect(aborted).toBe(true);
  });

  it("replaces the live provider set so newly discovered providers appear and removed ones disappear", async () => {
    const path = await cachePath();
    let now = 1_000;
    let generation = 0;
    const fetch: CatalogFetch = async () => response(generation++ === 0
      ? catalog({ retired: provider("retired", "@ai-sdk/openai-compatible", { old: model("old") }) })
      : catalog({ discovered: provider("discovered", "@ai-sdk/openai-compatible", { new: model("new") }) }));
    const client = new ModelsDevCatalogClient({ cachePath: path, fetch, clock: () => now, ttlMs: 1 });
    expect((await client.load()).catalog.providers.has("retired")).toBe(true);
    now += 1;

    const refreshed = await client.load();

    expect(refreshed.catalog.providers.has("retired")).toBe(false);
    expect(refreshed.catalog.providers.has("discovered")).toBe(true);
  });

  it("filters supported tool-capable non-deprecated models deterministically without a catalog-order default", async () => {
    const path = await cachePath();
    const fetch: CatalogFetch = async () => response(catalog({
      zeta: provider("zeta", "@ai-sdk/openai-compatible", { callable: model("callable") }),
      alpha: provider("alpha", "@ai-sdk/anthropic", { deprecated: model("deprecated", { status: "deprecated" }), "no-tools": model("no-tools", { tool_call: false }) }),
      unknown: provider("unknown", "unrecognised-package", { callable: model("callable") }),
    }));
    const result = await new ModelsDevCatalogClient({ cachePath: path, fetch }).load();

    expect(toolCapableNonDeprecatedModels(result.catalog).map((entry) => [entry.provider.id, entry.model.id, entry.model.wireFamily])).toEqual([["zeta", "callable", "openai-chat"]]);
  });
});
