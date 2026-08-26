import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * Opt-in composer spell-checking, modeled on Claude Code's own spell-check feature.
 *
 * This module is intentionally free of any terminal-rendering or Ink dependency: it exposes a
 * plain "check this text, get back misspelled ranges" API plus the pieces needed to drive it
 * (checker detection, a debounced controller, and small text-segmentation helpers). The composer
 * in chat-tui.tsx owns turning the result into colored/underlined `<Text>` runs.
 */

// ---------------------------------------------------------------------------
// Checker detection
// ---------------------------------------------------------------------------

export const spellCheckerNames = ["aspell", "hunspell", "ispell"] as const;
export type SpellCheckerName = (typeof spellCheckerNames)[number];

export interface SpellCheckCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface SpellCheckCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options?: { readonly input?: string; readonly timeoutMs?: number },
  ): Promise<SpellCheckCommandResult>;
}

/** Array-form spawn only, no shell, matching the CommandRunner pattern used by src/secrets.ts. */
export const systemSpellCheckRunner: SpellCheckCommandRunner = {
  run(command, args, options) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = options?.timeoutMs === undefined ? undefined : setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        reject(error);
      });
      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
      });
      if (options?.input === undefined) child.stdin?.end();
      else child.stdin?.end(options.input);
    });
  },
};

export interface DetectSpellCheckerOptions {
  readonly preferred?: SpellCheckerName;
  readonly runner?: SpellCheckCommandRunner;
}

/** Detects a usable checker on PATH by probing `-v`. Never throws: absence just resolves undefined. */
export async function detectSpellChecker(options: DetectSpellCheckerOptions = {}): Promise<SpellCheckerName | undefined> {
  const runner = options.runner ?? systemSpellCheckRunner;
  const candidates = options.preferred === undefined ? spellCheckerNames : [options.preferred];
  for (const name of candidates) {
    if (await isCheckerAvailable(name, runner)) return name;
  }
  return undefined;
}

async function isCheckerAvailable(name: SpellCheckerName, runner: SpellCheckCommandRunner): Promise<boolean> {
  try {
    await runner.run(name, ["-v"], { timeoutMs: 2_000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Skip-heuristics: which words are worth sending to the checker at all
// ---------------------------------------------------------------------------

export interface WordCandidate {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Extracts checkable words from composer text, applying skip-heuristics along the way. Getting
 * this reasonably right matters more than exhaustive coverage, so the rules are deliberately
 * biased toward skipping anything code-shaped rather than risking false-positive underlines.
 *
 * Skips: backtick-enclosed spans, URLs, CLI flags (`--foo`, `-x`), camelCase/PascalCase and
 * ALL-CAPS identifiers, and any token with interior punctuation/digits (paths, snake_case,
 * dotted names, etc). Unicode letters are supported so non-English dictionaries are meaningful.
 */
export function extractCheckableWords(text: string): readonly WordCandidate[] {
  const masked = maskBackticks(text);
  const candidates: WordCandidate[] = [];
  const chunkPattern = /\S+/gu;
  for (const match of masked.matchAll(chunkPattern)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const classified = classifyChunk(raw);
    if (classified === undefined) continue;
    const wordStart = start + classified.leadingTrim;
    candidates.push({ text: classified.core, start: wordStart, end: wordStart + classified.core.length });
  }
  return candidates;
}

function maskBackticks(text: string): string {
  return text.replace(/`[^`]*`/gu, (span) => " ".repeat(span.length));
}

const schemeUrlPattern = /^[a-z][a-z0-9+.-]*:\/\//iu;
const wwwUrlPattern = /^www\./iu;
const leadingNonLetterPattern = /^[^\p{L}]+/u;
const trailingNonLetterPattern = /[^\p{L}]+$/u;
const wordShapePattern = /^\p{L}+(?:'\p{L}+)*$/u;
const camelCasePattern = /\p{Ll}\p{Lu}/u;

function classifyChunk(raw: string): { readonly core: string; readonly leadingTrim: number } | undefined {
  if (raw.length === 0) return undefined;
  if (raw.startsWith("-")) return undefined; // CLI flag: -x, --foo, --foo-bar
  if (schemeUrlPattern.test(raw) || wwwUrlPattern.test(raw)) return undefined; // URL
  if (/\d/u.test(raw)) return undefined; // code-looking: contains a digit

  const leadingTrim = leadingNonLetterPattern.exec(raw)?.[0].length ?? 0;
  const trailingTrim = trailingNonLetterPattern.exec(raw)?.[0].length ?? 0;
  if (leadingTrim + trailingTrim >= raw.length) return undefined;
  const core = raw.slice(leadingTrim, raw.length - trailingTrim);

  if (!wordShapePattern.test(core)) return undefined; // interior punctuation: paths, snake_case, dotted names
  if (camelCasePattern.test(core)) return undefined; // camelCase / PascalCase identifier
  if (core.length > 1 && core === core.toUpperCase()) return undefined; // ALL-CAPS acronym

  return { core, leadingTrim };
}

// ---------------------------------------------------------------------------
// Subprocess invocation: batch/pipe ("ispell -a compatible") mode
// ---------------------------------------------------------------------------

export interface CheckWordsOptions {
  readonly checker: SpellCheckerName;
  readonly dictionary?: string;
  readonly runner?: SpellCheckCommandRunner;
  readonly timeoutMs?: number;
}

/**
 * Sends unique words to the checker in ispell/aspell/hunspell pipe mode (`-a`), one word per
 * line, each prefixed with `^` so a word can never be misread as a pipe-mode command. Words never
 * touch argv and the checker is invoked with array-form args (no shell), so there is no
 * shell-injection surface here even though word content ultimately comes from user text.
 */
export async function checkWords(words: readonly string[], options: CheckWordsOptions): Promise<ReadonlySet<string>> {
  if (words.length === 0) return new Set();
  const runner = options.runner ?? systemSpellCheckRunner;
  const args = ["-a", ...(options.dictionary === undefined ? [] : ["-d", options.dictionary])];
  const input = `${words.map((word) => `^${word}`).join("\n")}\n`;
  const result = await runner.run(options.checker, args, { input, timeoutMs: options.timeoutMs ?? 5_000 });
  return parseMisspelledWords(result.stdout);
}

/**
 * Parses ispell/aspell/hunspell `-a` output. Misspelling lines carry the original word as their
 * second field (`& word count offset: suggestions` or `# word offset`), so the misspelled set is
 * read directly off that field rather than by correlating output lines positionally with input
 * lines — robust to banner lines, terse/verbose mode, and blank-line quirks across the three tools.
 */
export function parseMisspelledWords(stdout: string): ReadonlySet<string> {
  const misspelled = new Set<string>();
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.startsWith("&") && !line.startsWith("#")) continue;
    const word = line.split(/\s+/u)[1];
    if (word !== undefined && word.length > 0) misspelled.add(word);
  }
  return misspelled;
}

// ---------------------------------------------------------------------------
// High-level "check this composer text" API
// ---------------------------------------------------------------------------

export interface MisspelledRange {
  readonly start: number;
  readonly end: number;
  readonly word: string;
}

export interface CheckComposerTextOptions {
  readonly checker: SpellCheckerName;
  readonly dictionary?: string;
  readonly runner?: SpellCheckCommandRunner;
  readonly timeoutMs?: number;
}

export async function checkComposerText(text: string, options: CheckComposerTextOptions): Promise<readonly MisspelledRange[]> {
  const candidates = extractCheckableWords(text);
  if (candidates.length === 0) return [];
  const uniqueWords = [...new Set(candidates.map((candidate) => candidate.text))];
  const misspelled = await checkWords(uniqueWords, options);
  if (misspelled.size === 0) return [];
  return candidates
    .filter((candidate) => misspelled.has(candidate.text))
    .map((candidate) => ({ start: candidate.start, end: candidate.end, word: candidate.text }));
}

// ---------------------------------------------------------------------------
// Text segmentation for rendering (pure, no Ink/React dependency)
// ---------------------------------------------------------------------------

export interface TextSegment {
  readonly text: string;
  readonly misspelled: boolean;
}

/** Splits `text` (a slice of the full composer value starting at `offset`) into plain/misspelled runs. */
export function segmentText(text: string, offset: number, ranges: readonly MisspelledRange[]): readonly TextSegment[] {
  if (text.length === 0) return [];
  const relevant = ranges
    .filter((range) => range.end > offset && range.start < offset + text.length)
    .map((range) => ({ start: Math.max(0, range.start - offset), end: Math.min(text.length, range.end - offset) }))
    .sort((left, right) => left.start - right.start);

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const range of relevant) {
    const start = Math.max(cursor, range.start);
    if (start > cursor) segments.push({ text: text.slice(cursor, start), misspelled: false });
    if (range.end > start) {
      segments.push({ text: text.slice(start, range.end), misspelled: true });
      cursor = range.end;
    }
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), misspelled: false });
  return segments;
}

// ---------------------------------------------------------------------------
// Debounced controller: "don't re-check on every keystroke"
// ---------------------------------------------------------------------------

export const defaultSpellCheckDebounceMs = 400;

export interface SpellCheckControllerOptions {
  readonly checkText: (text: string) => Promise<readonly MisspelledRange[]>;
  readonly onResult: (ranges: readonly MisspelledRange[]) => void;
  readonly debounceMs?: number;
  readonly scheduleTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearScheduledTimeout?: (handle: unknown) => void;
}

/**
 * Debounces text updates and runs at most one in-flight check at a time, discarding stale
 * results from checks superseded by a later `setText` call before they resolved.
 */
export class SpellCheckController {
  private readonly debounceMs: number;
  private readonly schedule: (callback: () => void, ms: number) => unknown;
  private readonly clear: (handle: unknown) => void;
  private timer: unknown;
  private generation = 0;

  constructor(private readonly options: SpellCheckControllerOptions) {
    this.debounceMs = options.debounceMs ?? defaultSpellCheckDebounceMs;
    this.schedule = options.scheduleTimeout ?? ((callback, ms) => setTimeout(callback, ms));
    this.clear = options.clearScheduledTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  setText(text: string): void {
    if (this.timer !== undefined) this.clear(this.timer);
    const generation = (this.generation += 1);
    this.timer = this.schedule(() => {
      this.timer = undefined;
      this.options.checkText(text)
        .then((ranges) => { if (generation === this.generation) this.options.onResult(ranges); })
        .catch(() => { if (generation === this.generation) this.options.onResult([]); });
    }, this.debounceMs);
  }

  dispose(): void {
    if (this.timer !== undefined) this.clear(this.timer);
    this.timer = undefined;
    this.generation += 1; // orphan any in-flight check so its result is never delivered
  }
}

// ---------------------------------------------------------------------------
// Settings: user-level, local-only, default OFF
// ---------------------------------------------------------------------------

/**
 * Spell-check preference lives outside AlfaCodeConfig (src/config.ts) on purpose. That schema is
 * scoped tightly to non-secret *provider* metadata (`ConfigStore` docs itself as "Stores only
 * non-secret provider metadata") and is shared, actively-edited ground for provider/connection
 * work. A UI preference like spell-check has nothing to do with providers and would only add
 * churn to a schema other tiers depend on. AlfaCode already has a precedent for exactly this kind
 * of local-only preference/state: `src/model-selection-state.ts`'s `FileModelSelectionStateStore`
 * persists its own small JSON file under `~/.alfacode/state/`, independent of AlfaCodeConfig. This
 * module follows that same pattern for `~/.alfacode/state/spellcheck.json`.
 */
export interface SpellCheckSettings {
  readonly enabled: boolean;
  readonly checker?: SpellCheckerName;
  readonly dictionary?: string;
  readonly underlineColor?: string;
}

export const defaultSpellCheckSettings: SpellCheckSettings = { enabled: false };

export function defaultSpellCheckSettingsPath(homeDirectory: string = homedir()): string {
  return join(homeDirectory, ".alfacode", "state", "spellcheck.json");
}

export interface SpellCheckSettingsStore {
  load(): Promise<SpellCheckSettings>;
  save(settings: SpellCheckSettings): Promise<void>;
}

export class MemorySpellCheckSettingsStore implements SpellCheckSettingsStore {
  private settings: SpellCheckSettings = defaultSpellCheckSettings;

  async load(): Promise<SpellCheckSettings> { return this.settings; }

  async save(settings: SpellCheckSettings): Promise<void> { this.settings = settings; }
}

/** Same private-file discipline as FileModelSelectionStateStore: 0700 dir, 0600 file, no symlinks, atomic rename. */
export class FileSpellCheckSettingsStore implements SpellCheckSettingsStore {
  constructor(private readonly path: string) {}

  async load(): Promise<SpellCheckSettings> {
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("Spell-check settings file is unsafe");
      return parseSettings(await readFile(this.path, "utf8"));
    } catch (error: unknown) {
      if (isMissing(error)) return defaultSpellCheckSettings;
      throw error;
    }
  }

  async save(settings: SpellCheckSettings): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (directoryInfo.mode & 0o077) !== 0) {
      throw new Error("Spell-check settings directory must be private");
    }
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(settings), { mode: 0o600, flag: "wx" });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }
}

function parseSettings(value: string): SpellCheckSettings {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { enabled?: unknown }).enabled !== "boolean") {
    throw new Error("Spell-check settings are invalid");
  }
  const candidate = parsed as { enabled: boolean; checker?: unknown; dictionary?: unknown; underlineColor?: unknown };
  const checker = spellCheckerNames.includes(candidate.checker as SpellCheckerName) ? (candidate.checker as SpellCheckerName) : undefined;
  const dictionary = typeof candidate.dictionary === "string" ? candidate.dictionary : undefined;
  const underlineColor = typeof candidate.underlineColor === "string" ? candidate.underlineColor : undefined;
  return {
    enabled: candidate.enabled,
    ...(checker === undefined ? {} : { checker }),
    ...(dictionary === undefined ? {} : { dictionary }),
    ...(underlineColor === undefined ? {} : { underlineColor }),
  };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
