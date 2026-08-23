import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AutomaticModelSelector,
  type AvailabilityProbe,
  type ModelUsageHistory,
  type QuotaReporter,
} from "../src/model-selection.js";
import { FileModelSelectionStateStore, MemoryModelSelectionStateStore } from "../src/model-selection-state.js";
import type { ModelDescriptor } from "../src/providers/foundation/types.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true }))); });

function model(id: string, overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    providerId: "test-provider",
    id,
    displayName: id,
    wireProtocol: "anthropic-messages",
    capabilities: { streaming: true, tools: true, parallelTools: true, forcedToolChoice: true, vision: true, reasoningState: "optional", nativeTokenCounting: true, jsonSchema: "full" },
    availability: "available",
    support: "contract-tested",
    ...overrides,
  };
}

describe("AutomaticModelSelector", () => {
  it("uses only the current dynamic catalog and prunes removed models from learned state", async () => {
    const state = new MemoryModelSelectionStateStore();
    const selector = new AutomaticModelSelector({ stateStore: state });
    await selector.select([model("discovered-now")]);
    await selector.recordOutcome({ providerId: "test-provider", modelId: "discovered-now", statusCode: 404 });

    const result = await selector.select([model("discovered-later")]);

    expect(result.selected?.id).toBe("discovered-later");
    expect(Object.keys((await state.load()).models)).toEqual([JSON.stringify(["test-provider", "discovered-later"])]);
  });

  it("learns 404 and Retry-After cooldowns without retrying those models", async () => {
    let now = 1_000;
    const selector = new AutomaticModelSelector({ clock: () => now });
    const first = model("candidate-a");
    const second = model("candidate-b");

    expect((await selector.select([first, second])).selected?.id).toBe("candidate-a");
    await selector.recordOutcome({ providerId: first.providerId, modelId: first.id, statusCode: 404 });
    const after404 = await selector.select([first, second]);
    expect(after404.selected?.id).toBe("candidate-b");
    expect(after404.explanations.find((entry) => entry.modelId === first.id)?.reasons).toContain("learned-not-found");

    await selector.recordOutcome({ providerId: second.providerId, modelId: second.id, statusCode: 429, retryAfter: "2" });
    expect((await selector.select([first, second])).selected).toBeUndefined();
    now += 2_001;
    expect((await selector.select([first, second])).selected?.id).toBe("candidate-b");
  });

  it("keeps unknown quota unknown and schedules equal candidates fairly and deterministically", async () => {
    const quota: QuotaReporter = { getQuota: async () => ({ known: false }) };
    const selector = new AutomaticModelSelector({ quotaReporter: quota });
    const left = model("left");
    const right = model("right");

    const first = await selector.select([right, left]);
    const second = await selector.select([right, left]);

    expect(first.selected).toBeDefined();
    expect(second.selected).toBeDefined();
    expect(second.selected?.id).not.toBe(first.selected?.id);
    expect(first.explanations.find((entry) => entry.modelId === first.selected?.id)).toMatchObject({ quota: "unknown", reasons: expect.arrayContaining(["fair-scheduling"]) });
  });

  it("uses provider-reported headroom only when both values are known", async () => {
    const quota: QuotaReporter = {
      getQuota: async (candidate) => candidate.id === "lower" ? { known: true, headroom: 0.2 } : { known: true, headroom: 0.7 },
    };
    const selector = new AutomaticModelSelector({ quotaReporter: quota });

    expect((await selector.select([model("lower"), model("higher")])).selected?.id).toBe("higher");
  });

  it("filters incompatible capability contracts and reports no eligible candidate", async () => {
    const noTools = model("no-tools", { capabilities: { ...model("scratch").capabilities, tools: false } });
    const selector = new AutomaticModelSelector();

    const result = await selector.select([noTools], { tools: true, contractTested: true });

    expect(result.selected).toBeUndefined();
    expect(result.explanations[0]).toMatchObject({ eligible: false, reasons: expect.arrayContaining(["capability-mismatch"]) });
  });

  it("uses rolling local usage before a stable lexical tie-break", async () => {
    const history: ModelUsageHistory = {
      rollingUsage: async (candidate) => candidate.id === "used" ? { attempts: 3, totalTokens: 100 } : { attempts: 0 },
    };
    const selector = new AutomaticModelSelector({ usageHistory: history });

    expect((await selector.select([model("used"), model("fresh")])).selected?.id).toBe("fresh");
  });

  it("bounds concurrent non-billable availability probes and honors their result", async () => {
    let active = 0;
    let maximum = 0;
    const probe: AvailabilityProbe = {
      probe: async (candidate) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active -= 1;
        return { status: candidate.id === "blocked" ? "unavailable" : "available" };
      },
    };
    const selector = new AutomaticModelSelector({ availabilityProbe: probe, maxConcurrentChecks: 2 });
    const result = await selector.select([model("one"), model("two"), model("blocked"), model("three")]);

    expect(maximum).toBeLessThanOrEqual(2);
    expect(result.explanations.find((entry) => entry.modelId === "blocked")).toMatchObject({ eligible: false, reasons: expect.arrayContaining(["probe-unavailable"]) });
  });

  it("persists only private model scheduling metadata when a caller opts into a cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alfacode-model-selection-"));
    directories.push(directory);
    const path = join(directory, "selector.json");
    const state = new FileModelSelectionStateStore(path);
    const selector = new AutomaticModelSelector({ stateStore: state });

    await selector.select([model("persisted")]);

    expect((await stat(directory)).mode & 0o077).toBe(0);
    expect((await stat(path)).mode & 0o077).toBe(0);
    expect(Object.keys((await state.load()).models)).toHaveLength(1);
  });
});
