import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

const secretReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("env"), name: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("keychain"), service: z.string().min(1), account: z.string().min(1) }).strict(),
]);

const providerIdSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine((value) => !/^(?:sk-|nvapi-|AIza)/i.test(value), "Provider id must be a local label, not an API key");

const providerSchema = z.object({
  id: providerIdSchema,
  type: z.string().min(1),
  apiKey: secretReferenceSchema.optional(),
  options: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const alfacodeConfigSchema = z.object({
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
export type AlfaCodeConfig = z.infer<typeof alfacodeConfigSchema>;

export const emptyConfig = (): AlfaCodeConfig => ({ version: 1, providers: [] });

export interface ConfigStoreOptions {
  readonly homeDirectory?: string;
  readonly configPath?: string;
}

export interface LegacyMigrationOptions {
  readonly target: ConfigStore;
  readonly legacyConfigPath?: string;
}

export interface LegacyMigrationResult {
  readonly migrated: boolean;
  readonly sourcePath: string;
}

/** Stores only non-secret provider metadata. Secret material belongs in Keychain or an environment variable. */
export class ConfigStore {
  readonly homeDirectory: string;
  readonly path: string;
  readonly directory: string;

  constructor(options: ConfigStoreOptions = {}) {
    this.homeDirectory = options.homeDirectory ?? homedir();
    this.path = options.configPath ?? join(this.homeDirectory, ".alfacode", "config.json");
    this.directory = dirname(this.path);
  }

  async exists(): Promise<boolean> {
    try {
      await this.assertSafePath(this.directory, true);
      await this.assertRegularFile(this.path);
      return true;
    } catch (error: unknown) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async read(): Promise<AlfaCodeConfig> {
    try {
      await this.assertSafePath(this.directory, true);
      await this.assertRegularFile(this.path);
      const raw = await readFile(this.path, "utf8");
      return alfacodeConfigSchema.parse(JSON.parse(raw));
    } catch (error: unknown) {
      if (isNotFound(error)) return emptyConfig();
      throw error;
    }
  }

  async write(config: AlfaCodeConfig): Promise<void> {
    const validated = alfacodeConfigSchema.parse(config);
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

  async update(mutator: (config: AlfaCodeConfig) => AlfaCodeConfig): Promise<AlfaCodeConfig> {
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

/**
 * Imports metadata only. Keychain references retain their original service/account,
 * so no secret bytes are read, copied, or written during migration.
 */
export async function migrateLegacyConfig(options: LegacyMigrationOptions): Promise<LegacyMigrationResult> {
  const sourcePath = options.legacyConfigPath ?? join(options.target.homeDirectory, ".polycode", "config.json");
  if (await options.target.exists()) return { migrated: false, sourcePath };

  const legacy = new ConfigStore({ configPath: sourcePath, homeDirectory: options.target.homeDirectory });
  if (!await legacy.exists()) return { migrated: false, sourcePath };
  await options.target.write(await legacy.read());
  return { migrated: true, sourcePath };
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
