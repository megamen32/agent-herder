/**
 * The service of the common settings on one node.
 *
 * The node answers what it holds, takes the document of the owner and applies
 * it, and keeps the deviations it replaced. The node never starts anything
 * and never writes a file of another node: it writes the file of the product
 * of its own machine and nothing else.
 */

import { AutomationLaunchPolicyStore } from "../automation-launch-policy.js";
import { SettingsStore } from "../web/settings-store.js";
import {
  applyCommonSettingsDocument,
  restoreCommonSettingsLocalValues,
  type CommonSettingsApplyResult,
  type CommonSettingsLaunchPolicyTarget,
  type CommonSettingsTarget,
} from "./apply.js";
import { readOwnerDocument, type CommonSettingsDocument, type CommonSettingsHooksLever } from "./document.js";
import { CommonSettingsStateStore, type CommonSettingsNodeState, type CommonSettingsNodeStatus, type CommonSettingsRole } from "./node-state.js";
import { catchUpCommonSettings } from "./service.js";
import type { CommonSettingsTransport } from "./transport.js";

/** The settings of the product of this node, as the service needs them. */
export type CommonSettingsNodeTarget = CommonSettingsTarget;

/** The policy of the launch of this node, as the service needs it. */
export function launchPolicyTarget(store: AutomationLaunchPolicyStore): CommonSettingsLaunchPolicyTarget {
  return {
    read: async () => {
      const document = await store.readDocument();
      if (document.kind === "valid") return { kind: "valid", policy: document.policy, etag: document.etag };
      if (document.kind === "absent") return { kind: "absent", etag: document.etag };
      return { kind: "invalid", error: document.error, etag: document.etag };
    },
    replace: async (value: unknown, options: { ifMatch?: string }) => await store.replace(value, options),
  };
}

/** How the node service is built. */
export interface CommonSettingsNodeServiceOptions {
  /** The name of this node. */
  hostId: string;
  /** The role of this node in the contour of the common settings. */
  role: CommonSettingsRole;
  /** The node that owns the document, when this node is a member. */
  ownerHostId?: string | null;
  /** The address of the node that owns the document. */
  ownerTarget?: string | null;
  /** The durable state of this node. */
  stateStore: CommonSettingsStateStore;
  /** The settings of the product of this node. */
  target: CommonSettingsNodeTarget;
  /** The policy of the launch of this node. */
  launchPolicy?: CommonSettingsLaunchPolicyTarget;
  /** The lever of the prohibitions of the hooks of this node. */
  hooks?: CommonSettingsHooksLever;
  /** The transport to the owner of the document. */
  transport?: CommonSettingsTransport;
  /** The clock. */
  now?: () => Date;
}

/**
 * The common settings of one node.
 *
 * The owner of the document builds it from its own files; a member takes the
 * document of the owner and applies it to the files of its own machine.
 */
export class CommonSettingsNodeService {
  private readonly options: CommonSettingsNodeServiceOptions;

  constructor(options: CommonSettingsNodeServiceOptions) {
    this.options = options;
  }

  /** The role of this node. */
  get role(): CommonSettingsRole {
    return this.options.role;
  }

  /** The name of this node. */
  get hostId(): string {
    return this.options.hostId;
  }

  /** The state of this node. */
  async state(): Promise<CommonSettingsNodeState> {
    return await this.options.stateStore.read();
  }

  /** The state of this node, as the owner of the document reads it. */
  async status(): Promise<CommonSettingsNodeStatus> {
    const state = await this.state();
    return {
      hostId: this.options.hostId,
      role: this.options.role,
      optIn: state.optIn,
      appliedRevision: state.appliedRevision,
      appliedAt: state.appliedAt,
      conflicts: state.conflicts,
    };
  }

  /**
   * The document of the common settings.
   *
   * The owner of the document builds it from the files of its own machine. A
   * member answers with the document it holds, and with nothing when it holds
   * none: a node without a document never claims one.
   */
  async document(): Promise<CommonSettingsDocument | null> {
    if (this.options.role === "owner") {
      const store = this.options.target as SettingsStore;
      if (typeof store.readEnvironment !== "function") return null;
      return await readOwnerDocument({
        owner: this.options.hostId,
        store: {
          readEnvironment: async () => await store.readEnvironment(),
          readSecretValue: async (key: string) => await store.readSecretValue(key),
        },
        ...(this.options.launchPolicy ? { launchPolicy: this.options.launchPolicy } : {}),
        ...(this.options.hooks ? { hooks: this.options.hooks } : {}),
        ...(this.options.now ? { now: this.options.now } : {}),
      });
    }
    const state = await this.state();
    return state.document;
  }

  /**
   * The node takes the document of the owner.
   *
   * The owner of the document has nothing to take: it is the source of the
   * truth. A member pulls the document over the transport of the fleet and
   * applies it to the files of its own machine.
   */
  async notice(revision: string): Promise<CommonSettingsApplyResult> {
    if (this.options.role === "owner") {
      return {
        ok: false,
        hostId: this.options.hostId,
        appliedRevision: null,
        appliedAt: null,
        changed: [],
        conflicts: [],
        reason: "Этот узел — источник общих настроек: ему нечего брать.",
      };
    }
    const result = await this.catchUp();
    if (!result.ok) return result;
    if (result.appliedRevision !== revision && revision) {
      return {
        ...result,
        ok: false,
        reason: `Нода взяла другую ревизию (${result.appliedRevision ?? "неизвестно"}), а её просили ${revision}.`,
      };
    }
    return result;
  }

  /**
   * The node catches up with the document of the owner.
   *
   * A node that was off or that had no connection takes the current revision
   * when it comes back: nobody does it by hand.
   */
  async catchUp(): Promise<CommonSettingsApplyResult> {
    if (this.options.role !== "member" || !this.options.transport || !this.options.ownerTarget) {
      return {
        ok: false,
        hostId: this.options.hostId,
        appliedRevision: null,
        appliedAt: null,
        changed: [],
        conflicts: [],
        reason: "Этот узел не берёт общие настройки: владелец документа не назван.",
      };
    }
    const state = await this.state();
    const result = await catchUpCommonSettings({
      transport: this.options.transport,
      ownerTarget: this.options.ownerTarget,
      target: this.options.target,
      ...(this.options.launchPolicy ? { launchPolicy: this.options.launchPolicy } : {}),
      ...(this.options.hooks ? { hooks: this.options.hooks } : {}),
      state,
      hostId: this.options.hostId,
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    if (result.ok && result.appliedRevision !== state.appliedRevision) {
      const applied: CommonSettingsNodeState = {
        ...state,
        appliedRevision: result.appliedRevision,
        appliedAt: result.appliedAt,
        conflicts: result.conflicts,
        document: result.document ?? state.document,
      };
      await this.options.stateStore.write(applied);
    } else if (result.ok) {
      await this.options.stateStore.write({ ...state, conflicts: result.conflicts });
    }
    return result;
  }

  /**
   * The document is applied to the files of this node.
   *
   * The document is checked before the first write: a document that does not
   * hold its own revision never touches a file of the node.
   */
  async apply(document: unknown): Promise<CommonSettingsApplyResult> {
    const state = await this.state();
    const result = await applyCommonSettingsDocument({
      document,
      target: this.options.target,
      ...(this.options.launchPolicy ? { launchPolicy: this.options.launchPolicy } : {}),
      ...(this.options.hooks ? { hooks: this.options.hooks } : {}),
      state,
      hostId: this.options.hostId,
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    if (!result.ok) return result;
    await this.options.stateStore.write({
      ...state,
      appliedRevision: result.appliedRevision,
      appliedAt: result.appliedAt,
      conflicts: result.conflicts,
      document: result.document ?? state.document,
    });
    return result;
  }

  /** The opt-in flag of this node, set by the owner of this node. */
  async setOptIn(enabled: boolean): Promise<CommonSettingsNodeStatus> {
    await this.options.stateStore.setOptIn(enabled);
    return await this.status();
  }

  /** The local values of this node are put back. */
  async restore(): Promise<CommonSettingsApplyResult> {
    const state = await this.state();
    const result = await restoreCommonSettingsLocalValues({
      target: this.options.target,
      state,
      hostId: this.options.hostId,
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    await this.options.stateStore.write({ ...state, conflicts: result.conflicts });
    return result;
  }
}
