import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkComposerText,
  checkWords,
  defaultSpellCheckDebounceMs,
  defaultSpellCheckSettings,
  defaultSpellCheckSettingsPath,
  detectSpellChecker,
  extractCheckableWords,
  FileSpellCheckSettingsStore,
  MemorySpellCheckSettingsStore,
  parseMisspelledWords,
  segmentText,
  SpellCheckController,
  type SpellCheckCommandResult,
  type SpellCheckCommandRunner,
} from "../src/spellcheck.js";

const temporaryDirectories: string[] = [];
async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "alfacode-spellcheck-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function fakeRunner(handler: (command: string, args: readonly string[], input: string | undefined) => SpellCheckCommandResult | Promise<SpellCheckCommandResult>): SpellCheckCommandRunner {
  return { run: async (command, args, options) => handler(command, args, options?.input) };
}

describe("detectSpellChecker", () => {
  it("returns the first checker found on PATH, in aspell/hunspell/ispell order", async () => {
    const seen: string[] = [];
    const runner = fakeRunner((command) => {
      seen.push(command);
      if (command !== "hunspell") { const error = new Error("not found") as NodeJS.ErrnoException; error.code = "ENOENT"; throw error; }
      return { stdout: "hunspell 1.7.0\n", stderr: "", exitCode: 0 };
    });
    await expect(detectSpellChecker({ runner })).resolves.toBe("hunspell");
    expect(seen).toEqual(["aspell", "hunspell"]);
  });

  it("degrades silently (undefined, no throw) when none of the three is on PATH", async () => {
    const runner = fakeRunner(() => { throw Object.assign(new Error("not found"), { code: "ENOENT" }); });
    await expect(detectSpellChecker({ runner })).resolves.toBeUndefined();
  });

  it("only probes the preferred checker when one is configured", async () => {
    const seen: string[] = [];
    const runner = fakeRunner((command) => { seen.push(command); return { stdout: "", stderr: "", exitCode: 0 }; });
    await expect(detectSpellChecker({ runner, preferred: "ispell" })).resolves.toBe("ispell");
    expect(seen).toEqual(["ispell"]);
  });
});

describe("skip-heuristics: extractCheckableWords", () => {
  function wordsOf(text: string): readonly string[] {
    return extractCheckableWords(text).map((candidate) => candidate.text);
  }

  it("finds ordinary words with their exact offsets", () => {
    expect(extractCheckableWords("Hello wrold")).toEqual([
      { text: "Hello", start: 0, end: 5 },
      { text: "wrold", start: 6, end: 11 },
    ]);
  });

  it("every candidate's offsets round-trip back to its own text, across all cases below", () => {
    const samples = [
      "Hello wrold",
      "Don't, worry!",
      "run src/index.ts or node_modules or v2 or package.json",
      "see https://example.com/docs or www.example.org for more",
      "run with --verbose or -x enabled",
      "call getUserName on AlfaCode please",
      "run `misspeled word` here",
      "I asked the API a question",
    ];
    for (const sample of samples) {
      for (const candidate of extractCheckableWords(sample)) {
        expect(sample.slice(candidate.start, candidate.end)).toBe(candidate.text);
      }
    }
  });

  it("strips sentence punctuation and preserves contractions", () => {
    expect(wordsOf("Don't, worry!")).toEqual(["Don't", "worry"]);
  });

  it("skips code-looking tokens: paths, snake_case, dotted names, digits", () => {
    expect(wordsOf("run src/index.ts or node_modules or v2 or package.json")).toEqual(["run", "or", "or", "or"]);
  });

  it("skips URLs", () => {
    expect(wordsOf("see https://example.com/docs or www.example.org for more")).toEqual(["see", "or", "for", "more"]);
  });

  it("skips CLI flags", () => {
    expect(wordsOf("run with --verbose or -x enabled")).toEqual(["run", "with", "or", "enabled"]);
  });

  it("skips camelCase and PascalCase identifiers", () => {
    expect(wordsOf("call getUserName on AlfaCode please")).toEqual(["call", "on", "please"]);
  });

  it("skips anything inside backticks, even plain-looking words", () => {
    expect(wordsOf("run `misspeled word` here")).toEqual(["run", "here"]);
  });

  it("skips ALL-CAPS acronyms but keeps single-letter words", () => {
    expect(wordsOf("I asked the API a question")).toEqual(["I", "asked", "the", "a", "question"]);
  });

  it("supports Unicode letters, so a non-English dictionary is meaningful", () => {
    expect(wordsOf("è una città bellissima")).toEqual(["è", "una", "città", "bellissima"]);
  });

  it("does not flag most of a pasted code snippet", () => {
    const snippet = "const userName = getUserName(); // fetch it from /api/v2/users.json";
    expect(wordsOf(snippet)).toEqual(["const", "fetch", "it", "from"]);
  });
});

describe("subprocess invocation (mocked)", () => {
  it("sends unique words one-per-line, caret-prefixed, over stdin, with array-form args", async () => {
    let capturedArgs: readonly string[] = [];
    let capturedInput = "";
    const runner = fakeRunner((command, args, input) => {
      expect(command).toBe("aspell");
      capturedArgs = args;
      capturedInput = input ?? "";
      return { stdout: "@(#) banner\n\n& wrold 2 6: world, wrold\n\n", stderr: "", exitCode: 0 };
    });
    const result = await checkWords(["Hello", "wrold"], { checker: "aspell", dictionary: "en_US", runner });
    expect(capturedArgs).toEqual(["-a", "-d", "en_US"]);
    expect(capturedInput).toBe("^Hello\n^wrold\n");
    expect(result).toEqual(new Set(["wrold"]));
  });

  it("never puts word content in argv", async () => {
    const runner = fakeRunner((_command, args) => {
      expect(args.some((arg) => arg.includes("wrold"))).toBe(false);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    await checkWords(["wrold"], { checker: "hunspell", runner });
  });

  it("returns an empty set without spawning when there are no words", async () => {
    const runner = fakeRunner(() => { throw new Error("must not spawn"); });
    await expect(checkWords([], { checker: "aspell", runner })).resolves.toEqual(new Set());
  });
});

describe("parseMisspelledWords", () => {
  it("reads the original word off & and # lines regardless of banners or blank-line noise", () => {
    const stdout = [
      "@(#) International Ispell Version 3.1.20",
      "",
      "& wrold 2 6: world, wrold",
      "",
      "# gud 0",
      "",
      "*",
      "",
    ].join("\n");
    expect(parseMisspelledWords(stdout)).toEqual(new Set(["wrold", "gud"]));
  });

  it("treats correctly-spelled words (no & or # line) as not misspelled", () => {
    expect(parseMisspelledWords("@(#) banner\n\n*\n\n")).toEqual(new Set());
  });
});

describe("checkComposerText end-to-end (mocked checker)", () => {
  it("only sends checkable candidates and maps misspellings back to text ranges", async () => {
    const runner = fakeRunner((_command, _args, input) => {
      expect(input).toBe("^Wrold\n^Hello\n");
      return { stdout: "& Wrold 1 0: World\n\n", stderr: "", exitCode: 0 };
    });
    const ranges = await checkComposerText("Wrold Hello src/index.ts", { checker: "aspell", runner });
    expect(ranges).toEqual([{ start: 0, end: 5, word: "Wrold" }]);
  });
});

describe("segmentText", () => {
  it("splits a slice into plain/misspelled runs at the given offset", () => {
    expect(segmentText("Wrold Hello", 0, [{ start: 0, end: 5, word: "Wrold" }])).toEqual([
      { text: "Wrold", misspelled: true },
      { text: " Hello", misspelled: false },
    ]);
  });

  it("clips ranges that only partially overlap the slice", () => {
    // Full text is "Hello Wrold", slice starts at offset 6 ("Wrold").
    expect(segmentText("Wrold", 6, [{ start: 0, end: 5, word: "Hello" }, { start: 6, end: 11, word: "Wrold" }])).toEqual([
      { text: "Wrold", misspelled: true },
    ]);
  });

  it("returns a single plain run when nothing is misspelled", () => {
    expect(segmentText("all good", 0, [])).toEqual([{ text: "all good", misspelled: false }]);
  });
});

describe("SpellCheckController debounce behavior", () => {
  it("does not check on every keystroke, only after the pause elapses", () => {
    vi.useFakeTimers();
    try {
      const checkText = vi.fn(async () => []);
      const controller = new SpellCheckController({ checkText, onResult: () => undefined, debounceMs: 300 });
      controller.setText("h");
      controller.setText("he");
      controller.setText("hel");
      vi.advanceTimersByTime(299);
      expect(checkText).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(checkText).toHaveBeenCalledTimes(1);
      expect(checkText).toHaveBeenCalledWith("hel");
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers the debounced result once the pause elapses", async () => {
    vi.useFakeTimers();
    try {
      const onResult = vi.fn();
      const controller = new SpellCheckController({
        checkText: async () => [{ start: 0, end: 3, word: "bad" }],
        onResult,
        debounceMs: 100,
      });
      controller.setText("bad text");
      await vi.advanceTimersByTimeAsync(100);
      expect(onResult).toHaveBeenCalledWith([{ start: 0, end: 3, word: "bad" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a stale in-flight result superseded by a later setText call", async () => {
    vi.useFakeTimers();
    try {
      const onResult = vi.fn();
      let resolveFirst!: (value: readonly { start: number; end: number; word: string }[]) => void;
      const first = new Promise<readonly { start: number; end: number; word: string }[]>((resolve) => { resolveFirst = resolve; });
      let callCount = 0;
      const controller = new SpellCheckController({
        checkText: async () => { callCount += 1; return callCount === 1 ? first : []; },
        onResult,
        debounceMs: 50,
      });

      controller.setText("first");
      await vi.advanceTimersByTimeAsync(50); // fires the first (still-pending) check

      controller.setText("second");
      await vi.advanceTimersByTimeAsync(50); // fires and resolves the second check first
      expect(onResult).toHaveBeenCalledTimes(1);
      expect(onResult).toHaveBeenLastCalledWith([]);

      resolveFirst([{ start: 0, end: 5, word: "first" }]);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(onResult).toHaveBeenCalledTimes(1); // the stale first result must never arrive
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the pause on every new keystroke instead of firing on a fixed interval", () => {
    vi.useFakeTimers();
    try {
      const checkText = vi.fn(async () => []);
      const controller = new SpellCheckController({ checkText, onResult: () => undefined, debounceMs: 300 });
      controller.setText("h");
      vi.advanceTimersByTime(250);
      controller.setText("he"); // resets the timer before it fires
      vi.advanceTimersByTime(250);
      expect(checkText).not.toHaveBeenCalled();
      vi.advanceTimersByTime(50);
      expect(checkText).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops delivering results after dispose", async () => {
    vi.useFakeTimers();
    try {
      const onResult = vi.fn();
      const controller = new SpellCheckController({ checkText: async () => [], onResult, debounceMs: 50 });
      controller.setText("text");
      controller.dispose();
      await vi.advanceTimersByTimeAsync(100);
      expect(onResult).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults to a short-pause debounce", () => {
    expect(defaultSpellCheckDebounceMs).toBeGreaterThan(0);
    expect(defaultSpellCheckDebounceMs).toBeLessThanOrEqual(1_000);
  });
});

describe("spell-check settings (user-level, local-only, default OFF)", () => {
  it("defaults to disabled", () => {
    expect(defaultSpellCheckSettings.enabled).toBe(false);
  });

  it("keeps settings under ~/.alfacode/state, independent of AlfaCodeConfig", () => {
    expect(defaultSpellCheckSettingsPath("/home/user")).toBe(join("/home/user", ".alfacode", "state", "spellcheck.json"));
  });

  it("round-trips through an in-memory store", async () => {
    const store = new MemorySpellCheckSettingsStore();
    expect(await store.load()).toEqual(defaultSpellCheckSettings);
    await store.save({ enabled: true, checker: "hunspell", dictionary: "en_GB", underlineColor: "red" });
    expect(await store.load()).toEqual({ enabled: true, checker: "hunspell", dictionary: "en_GB", underlineColor: "red" });
  });

  it("persists to a private file (0700 dir, 0600 file) and survives a reload", async () => {
    const directory = await createTemporaryDirectory();
    const path = join(directory, "state", "spellcheck.json");
    const store = new FileSpellCheckSettingsStore(path);

    await store.save({ enabled: true, checker: "aspell", underlineColor: "yellow" });

    expect((await lstat(join(directory, "state"))).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await store.load()).toEqual({ enabled: true, checker: "aspell", underlineColor: "yellow" });
  });

  it("falls back to defaults before any settings file exists", async () => {
    const directory = await createTemporaryDirectory();
    const store = new FileSpellCheckSettingsStore(join(directory, "spellcheck.json"));
    expect(await store.load()).toEqual(defaultSpellCheckSettings);
  });
});
