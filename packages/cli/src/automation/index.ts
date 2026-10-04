export type {
  AutomationAnswer,
  TrustedQuestionManifest,
} from "./answer-file.js";
export { AutomationAnswers, loadAutomationAnswers } from "./answer-file.js";
export type {
  CliAutomationErrorCode,
  CliAutomationErrorOptions,
} from "./errors.js";
export { CliAutomationError } from "./errors.js";
export type {
  LoadManagedPolicyOptions,
  ManagedCapability,
  ManagedCapabilityRule,
  ManagedPolicyAssessment,
  ManagedPolicyDocument,
} from "./managed-policy.js";
export {
  loadManagedPolicy,
  MANAGED_CAPABILITIES,
  ManagedPolicy,
  parseManagedPolicyDocument,
} from "./managed-policy.js";
export type {
  LoadNonInteractiveAutomationOptions,
  NonInteractiveAutomationOptions,
} from "./non-interactive-policy.js";
export {
  isCliAutomationError,
  loadNonInteractiveAutomation,
  NonInteractiveAutomation,
} from "./non-interactive-policy.js";
export type {
  PolicyAuditEvent,
  PolicyAuditLogOptions,
  PolicyAuditRecord,
  PolicyAuditWriter,
} from "./policy-audit.js";
export { PolicyAuditLog } from "./policy-audit.js";
