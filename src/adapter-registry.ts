import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HarnessAdapter } from "./types/index.js";
import { getHarnessCapabilities, type HarnessCapabilities } from "./types/index.js";

export type AdapterFactory = () => HarnessAdapter | Promise<HarnessAdapter>;

export interface AdapterDefinition {
  id: string;
  name: string;
  description: string;
  defaultEnabled: boolean;
  factory?: AdapterFactory;
}

export interface AdapterStatus {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  active: boolean;
  status: "active" | "disabled" | "not_configured" | "error";
  capabilities: HarnessCapabilities | null;
  error?: string;
}

type Store = { version: 1; enabled: Record<string, boolean> };

export class AdapterRegistry {
  private readonly definitions = new Map<string, AdapterDefinition>();
  private readonly errors = new Map<string, string>();
  private readonly enabled = new Map<string, boolean>();

  constructor(
    private readonly adapters: Map<string, HarnessAdapter>,
    private readonly storePath: string,
  ) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.storePath, "utf8")) as Partial<Store>;
      if (parsed.version === 1 && parsed.enabled && typeof parsed.enabled === "object") {
        for (const [id, value] of Object.entries(parsed.enabled)) {
          if (typeof value === "boolean") this.enabled.set(id, value);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[agent-herder] adapter registry could not load: ${(error as Error).message}`);
      }
    }
  }

  register(definition: AdapterDefinition): void {
    this.definitions.set(definition.id, definition);
    if (!this.enabled.has(definition.id)) this.enabled.set(definition.id, definition.defaultEnabled);
  }

  registerActive(adapter: HarnessAdapter): void {
    this.adapters.set(adapter.type, adapter);
    this.errors.delete(adapter.type);
  }

  shouldEnable(id: string, fallback: boolean): boolean {
    return this.enabled.has(id) ? this.enabled.get(id) === true : fallback;
  }

  list(): AdapterStatus[] {
    return [...this.definitions.values()].map((definition) => {
      const adapter = this.adapters.get(definition.id);
      const enabled = this.enabled.get(definition.id) === true;
      return {
        id: definition.id,
        name: definition.name,
        description: definition.description,
        enabled,
        active: Boolean(adapter),
        status: this.errors.has(definition.id)
          ? "error"
          : adapter ? "active" : enabled && !definition.factory ? "not_configured" : "disabled",
        capabilities: adapter ? getHarnessCapabilities(adapter) : null,
        ...(this.errors.has(definition.id) ? { error: this.errors.get(definition.id) } : {}),
      };
    });
  }

  async setEnabled(id: string, value: boolean): Promise<AdapterStatus> {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error(`Unknown adapter '${id}'`);
    if (!value) {
      const adapter = this.adapters.get(id);
      if (adapter && typeof (adapter as HarnessAdapter & { dispose?: () => Promise<void> }).dispose === "function") {
        await (adapter as HarnessAdapter & { dispose: () => Promise<void> }).dispose();
      }
      this.adapters.delete(id);
      this.enabled.set(id, false);
      this.errors.delete(id);
      await this.persist();
      return this.list().find((item) => item.id === id)!;
    }
    if (!definition.factory) {
      this.enabled.set(id, true);
      await this.persist();
      return this.list().find((item) => item.id === id)!;
    }
    try {
      const adapter = await definition.factory();
      await adapter.init();
      this.adapters.set(id, adapter);
      this.enabled.set(id, true);
      this.errors.delete(id);
      await this.persist();
    } catch (error) {
      this.enabled.set(id, false);
      this.errors.set(id, (error as Error).message);
      await this.persist();
    }
    return this.list().find((item) => item.id === id)!;
  }

  private async persist(): Promise<void> {
    const payload: Store = { version: 1, enabled: Object.fromEntries(this.enabled) };
    await mkdir(dirname(this.storePath), { recursive: true });
    const temporary = `${this.storePath}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.storePath);
  }
}
