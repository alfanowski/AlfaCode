import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ToolCallState {
  id: string;
  name: string;
  thoughtSignature?: string;
}

export interface GoogleStateStore {
  get(session: string, agent: string, toolUseId: string): Promise<ToolCallState | undefined>;
  put(session: string, agent: string, toolUseId: string, value: ToolCallState): Promise<void>;
  close?(): Promise<void>;
}

/** A small durable store. Writes are atomically replaced, so a crash never leaves partial JSON. */
export class FileGoogleStateStore implements GoogleStateStore {
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(private readonly path: string) {}

  public async get(session: string, agent: string, toolUseId: string): Promise<ToolCallState | undefined> {
    const data = await this.read();
    return data[this.key(session, agent, toolUseId)];
  }

  public async put(session: string, agent: string, toolUseId: string, value: ToolCallState): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const data = await this.read();
      data[this.key(session, agent, toolUseId)] = value;
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await chmod(dirname(this.path), 0o700);
      const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.path);
    });
    return this.writeChain;
  }

  private key(session: string, agent: string, toolUseId: string): string {
    return JSON.stringify([session, agent, toolUseId]);
  }

  private async read(): Promise<Record<string, ToolCallState>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      return isRecord(parsed) ? parsed as Record<string, ToolCallState> : {};
    } catch (error: unknown) {
      if (isRecord(error) && error.code === 'ENOENT') return {};
      throw error;
    }
  }
}

export class MemoryGoogleStateStore implements GoogleStateStore {
  private readonly values = new Map<string, ToolCallState>();
  public async get(session: string, agent: string, toolUseId: string): Promise<ToolCallState | undefined> {
    return this.values.get(JSON.stringify([session, agent, toolUseId]));
  }
  public async put(session: string, agent: string, toolUseId: string, value: ToolCallState): Promise<void> {
    this.values.set(JSON.stringify([session, agent, toolUseId]), value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
