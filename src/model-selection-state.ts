import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ModelSelectionHealth {
  readonly selections: number;
  readonly lastSelectedAt?: number;
  readonly unavailableUntil?: number;
  readonly unavailableReason?: "not-found" | "rate-limited" | "probe";
  readonly lastProbe?: {
    readonly status: "available" | "unavailable" | "unknown";
    readonly checkedAt: number;
    readonly expiresAt: number;
  };
  readonly quota?: {
    readonly known: boolean;
    readonly checkedAt: number;
    readonly expiresAt: number;
    readonly headroom?: number;
    readonly remainingRequests?: number;
    readonly remainingTokens?: number;
  };
}

export interface ModelSelectionState {
  readonly version: 1;
  readonly models: Readonly<Record<string, ModelSelectionHealth>>;
}

export interface ModelSelectionStateStore {
  load(): Promise<ModelSelectionState>;
  save(state: ModelSelectionState): Promise<void>;
}

export class MemoryModelSelectionStateStore implements ModelSelectionStateStore {
  private state: ModelSelectionState = { version: 1, models: {} };

  async load(): Promise<ModelSelectionState> { return this.state; }

  async save(state: ModelSelectionState): Promise<void> { this.state = state; }
}

/**
 * Optional local state store. It contains only model health and scheduling
 * metadata; callers provide the path so configuration remains outside this module.
 */
export class FileModelSelectionStateStore implements ModelSelectionStateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<ModelSelectionState> {
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("Model selection state is unsafe");
      return parseState(await readFile(this.path, "utf8"));
    } catch (error: unknown) {
      if (isMissing(error)) return { version: 1, models: {} };
      throw error;
    }
  }

  async save(state: ModelSelectionState): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (directoryInfo.mode & 0o077) !== 0) {
      throw new Error("Model selection state directory must be private");
    }
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }
}

function parseState(value: string): ModelSelectionState {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== 1 || typeof (parsed as { models?: unknown }).models !== "object" || (parsed as { models?: unknown }).models === null) {
    throw new Error("Model selection state is invalid");
  }
  return parsed as ModelSelectionState;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
