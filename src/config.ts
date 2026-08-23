import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

const secretReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("env"), name: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("keychain"), service: z.string().min(1), account: z.string().min(1) }).strict(),
]);

const providerSchema = z.object({
  id: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  type: z.string().min(1),
  apiKey: secretReferenceSchema.optional(),
  options: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const polycodeConfigSchema = z.object({
  version: z.literal(1),
  defaultProviderId: z.string().min(1).optional(),
  providers: z.array(providerSchema),
}).strict().superRefine((config, ctx) => {
  const ids = new Set<string>();
  for (const provider of config.providers) {
    if (ids.has(provider.id)) {
      ctx.addIssue({ code: "custom", message: `Duplicate provider id: ${provider.id}`, path: ["providers"] });
    }
    ids.add(provider.id);
  }
  if (config.defaultProviderId !== undefined && !ids.has(config.defaultProviderId)) {
    ctx.addIssue({ code: "custom", message: "defaultProviderId must reference an existing provider", path: ["defaultProviderId"] });
  }
});

export type SecretReference = z.infer<typeof secretReferenceSchema>;
export type ProviderRecord = z.infer<typeof providerSchema>;
export type PolycodeConfig = z.infer<typeof polycodeConfigSchema>;

export const emptyConfig = (): PolycodeConfig => ({ version: 1, providers: [] });

export interface ConfigStoreOptions {
  readonly homeDirectory?: string;
  readonly configPath?: string;
}

/** Stores only non-secret provider metadata. Secret material belongs in Keychain or an environment variable. */
export class ConfigStore {
  readonly path: string;
  readonly directory: string;

  constructor(options: ConfigStoreOptions = {}) {
    this.path = options.configPath ?? join(options.homeDirectory ?? homedir(), ".polycode", "config.json");
    this.directory = dirname(this.path);
  }

  async read(): Promise<PolycodeConfig> {
    try {
      await this.assertSafePath(this.directory, true);
      await this.assertRegularFile(this.path);
      const raw = await readFile(this.path, "utf8");
      return polycodeConfigSchema.parse(JSON.parse(raw));
    } catch (error: unknown) {
      if (isNotFound(error)) return emptyConfig();
      throw error;
    }
  }

  async write(config: PolycodeConfig): Promise<void> {
    const validated = polycodeConfigSchema.parse(config);
    await this.ensureSafeDirectory();
    try {
      await this.assertRegularFile(this.path);
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error;
    }

    const temporaryPath = join(this.directory, `.config-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
    } finally {
      try {
        await unlink(temporaryPath);
      } catch (error: unknown) {
        if (!isNotFound(error)) throw error;
      }
    }
  }

  async update(mutator: (config: PolycodeConfig) => PolycodeConfig): Promise<PolycodeConfig> {
    const next = mutator(await this.read());
    await this.write(next);
    return next;
  }

  private async ensureSafeDirectory(): Promise<void> {
    try {
      await this.assertSafePath(this.directory, true);
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      await this.assertSafePath(this.directory, true);
    }
  }

  private async assertSafePath(path: string, directory: boolean): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Refusing symbolic link at ${path}`);
    if (directory && !info.isDirectory()) throw new Error(`Expected directory at ${path}`);
    if ((info.mode & 0o077) !== 0) throw new Error(`Refusing insecure permissions at ${path}`);
    if (process.getuid !== undefined && info.uid !== process.getuid()) throw new Error(`Refusing path not owned by the current user: ${path}`);
  }

  private async assertRegularFile(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Refusing symbolic link at ${path}`);
    if (!info.isFile()) throw new Error(`Expected regular file at ${path}`);
    if ((info.mode & 0o077) !== 0) throw new Error(`Refusing insecure permissions at ${path}`);
    if (process.getuid !== undefined && info.uid !== process.getuid()) throw new Error(`Refusing file not owned by the current user: ${path}`);
  }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
