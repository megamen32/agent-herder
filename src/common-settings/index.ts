/**
 * The common settings of the herder: one document, one revision, the whole fleet.
 *
 * The modules of this folder answer one question: how a setting that means
 * the same thing on every node of the fleet reaches every node that takes it,
 * and how the owner sees what every node holds.
 *
 * - `scope` — the one place that says which setting travels and which one
 *   belongs to its machine.
 * - `document` — the versioned document and its revision.
 * - `node-state` — the durable state of one node: the opt-in, the applied
 *   revision and the deviations.
 * - `apply` — the application of the document on a node.
 * - `transport` — the transport of the fleet that carries the document.
 * - `service` — the service of the owner: the fleet view and the catch-up.
 * - `node-service` — the service of one node.
 * - `tools` — the tools of the node on the fleet transport.
 */

export {
  assertNoMachineSettings,
  COMMON_SETTINGS_SCOPE,
  CommonSettingsMachineFieldError,
  commonEnvironmentKeys,
  isCommonSettingId,
  isSecretSettingId,
  MACHINE_SETTINGS_SCOPE,
  machineFieldsOfDocument,
  machineSettingIds,
  scopeOfSettingId,
  unclassifiedCatalogSettings,
  type CommonSettingScope,
  type CommonSettingScopeEntry,
} from "./scope.js";

export {
  buildCommonDocument,
  canonicalJson,
  COMMON_SETTINGS_FORMAT,
  commonSettingsRevision,
  CommonSettingsDocumentError,
  hooksLeverFromStore,
  parseCommonSettingsDocument,
  readOwnerDocument,
  redactCommonDocument,
  type CommonSettingsDocument,
  type CommonSettingsDocumentView,
  type CommonSettingsHooksLever,
  type CommonSettingsHooksState,
  type HooksProhibitionsStoreLike,
} from "./document.js";

export {
  CommonSettingsStateStore,
  COMMON_SETTINGS_STATE_FILE,
  emptyCommonSettingsState,
  type CommonSettingsConflict,
  type CommonSettingsNodeState,
  type CommonSettingsNodeStatus,
  type CommonSettingsRole,
} from "./node-state.js";

export {
  applyCommonSettingsDocument,
  restoreCommonSettingsLocalValues,
  type CommonSettingsApplyResult,
  type CommonSettingsLaunchPolicyTarget,
  type CommonSettingsTarget,
} from "./apply.js";

export {
  COMMON_SETTINGS_TOOLS,
  DirectCommonSettingsTransport,
  readStatus,
  readToolPayload,
  type CommonSettingsTransport,
} from "./transport.js";

export {
  catchUpCommonSettings,
  COMMON_SETTINGS_OWNER_ENV,
  COMMON_SETTINGS_SYNC_INTERVAL_MS,
  readCommonSettingsConfig,
  readCommonSettingsFleet,
  restoreLocalCommonSettings,
  type CommonSettingsFleetView,
  type CommonSettingsNodeView,
} from "./service.js";

export {
  CommonSettingsNodeService,
  launchPolicyTarget,
  type CommonSettingsNodeServiceOptions,
  type CommonSettingsNodeTarget,
} from "./node-service.js";

export { registerCommonSettingsTools } from "./tools.js";

export {
  commonSettingsService,
  startCommonSettingsSyncLoop,
} from "./runtime.js";
