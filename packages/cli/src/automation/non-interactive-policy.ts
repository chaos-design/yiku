import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  normalizeUserQuestionRequest,
  type PermissionApprovalHandler,
  type PermissionAssessmentHandler,
  type UserQuestionHandler,
  type UserQuestionResponse,
  type WorkspaceAccessMode,
  type WorkspaceWriteAccessApprovalHandler,
} from "@yiku/agent-orchestrator";
import { sha256 } from "@yiku/hooks";
import type { CliMachineDiagnostic } from "../output/types.js";
import {
  type AutomationAnswer,
  type AutomationAnswers,
  loadAutomationAnswers,
  type TrustedQuestionManifest,
} from "./answer-file.js";
import { approvalRequired, CliAutomationError, needsInput, policyDenied } from "./errors.js";
import { loadManagedPolicy, type ManagedPolicy } from "./managed-policy.js";
import { PolicyAuditLog, type PolicyAuditRecord, type PolicyAuditWriter } from "./policy-audit.js";

export interface NonInteractiveAutomationOptions {
  readonly accessMode?: WorkspaceAccessMode | undefined;
  readonly answers?: AutomationAnswers | undefined;
  readonly audit: PolicyAuditWriter;
  readonly now?: (() => Date) | undefined;
  readonly policy?: ManagedPolicy | undefined;
  readonly questionManifests?: readonly TrustedQuestionManifest[] | undefined;
  readonly sessionId?: string | undefined;
  readonly workspaceId: string;
}

export interface LoadNonInteractiveAutomationOptions {
  readonly accessMode: WorkspaceAccessMode;
  readonly answersFilePath?: string | undefined;
  readonly auditFilePath?: string | undefined;
  readonly homeDir?: string | undefined;
  readonly policyFilePath?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly workspaceDir: string;
}

export class NonInteractiveAutomation {
  private readonly accessMode: WorkspaceAccessMode;
  private readonly answers?: AutomationAnswers | undefined;
  private readonly audit: PolicyAuditWriter;
  private readonly diagnosticEntries: CliMachineDiagnostic[] = [];
  private readonly now: () => Date;
  private readonly policy?: ManagedPolicy | undefined;
  private readonly questionManifests: ReadonlyMap<string, TrustedQuestionManifest>;
  private readonly sessionId: string;
  private readonly workspaceId: string;

  public constructor(options: NonInteractiveAutomationOptions) {
    this.accessMode = options.accessMode ?? "read-only";
    this.answers = options.answers;
    this.audit = options.audit;
    this.now = options.now ?? (() => new Date());
    this.policy = options.policy;
    this.questionManifests = new Map(
      (options.questionManifests ?? []).map((manifest) => [manifest.questionKey, manifest]),
    );
    this.sessionId = options.sessionId ?? `cli-${randomUUID()}`;
    this.workspaceId = options.workspaceId;
  }

  public diagnostics(): readonly CliMachineDiagnostic[] {
    const unused = this.answers?.unusedQuestionKeys() ?? [];
    return Object.freeze([
      ...this.diagnosticEntries,
      ...unused.map((questionKey) => ({
        code: "CLI_UNUSED_AUTOMATION_ANSWER",
        message: `Configured answer was not used: ${questionKey}.`,
      })),
    ]);
  }

  public questionHandler(): UserQuestionHandler {
    return async (request) => {
      const normalized = normalizeUserQuestionRequest(request);
      const answers: StructuredAnswer[] = [];

      for (const [questionIndex, question] of normalized.questions.entries()) {
        const questionKey = question.questionKey;
        if (questionKey === undefined) {
          throw needsInput("Question has no stable questionKey and requires interactive input.");
        }
        if (question.risk === "permission" || question.risk === "secret") {
          throw needsInput(
            `Question ${questionKey} cannot be answered automatically because its risk is ${question.risk}.`,
            questionKey,
          );
        }

        const manifest =
          this.answers?.manifest(questionKey) ?? this.questionManifests.get(questionKey);
        if (manifest === undefined || !matchesTrustedManifest(question, manifest)) {
          throw needsInput(
            `Question ${questionKey} does not match a trusted automation manifest.`,
            questionKey,
          );
        }
        const configured = this.answers?.consume(questionKey);
        if (
          configured !== undefined &&
          (manifest.risk === "preference" || manifest.preconfiguredAnswer)
        ) {
          const answer = resolveAnswer(question, configured, questionIndex, questionKey);
          await this.auditLowRisk({
            decision: "allow",
            event: "answer.preconfigured",
            questionKey,
            reason: "Answer supplied by an explicit answers file.",
          });
          answers.push(answer);
          continue;
        }

        if (
          question.risk === "preference" &&
          question.allowAutoRecommended &&
          manifest?.allowAutoRecommended === true &&
          manifest.risk === question.risk
        ) {
          const recommendedIndex = trustedRecommendedIndex(
            question.options,
            manifest.recommendedOptionId,
          );
          if (recommendedIndex !== undefined) {
            const option = question.options[recommendedIndex];
            if (option?.optionId !== undefined) {
              await this.auditLowRisk({
                decision: "allow",
                event: "answer.auto-recommended",
                questionKey,
                reason: "Manifest allowed the unique recommended preference.",
              });
              answers.push({
                answers: [option.label],
                questionIndex,
                selectedIndexes: [recommendedIndex],
              });
              continue;
            }
          }
        }

        throw needsInput(
          `Question ${questionKey} requires a preconfigured answer or interactive input.`,
          questionKey,
        );
      }

      return normalizeQuestionResponse(normalized.source, answers);
    };
  }

  public permissionAssessmentHandler(): PermissionAssessmentHandler {
    return async (request, runtimeAssessment) => {
      if (runtimeAssessment === "deny") {
        throw policyDenied("Denied by runtime permission policy.", request.capabilities[0]);
      }
      if (this.accessMode === "read-only" && request.capabilities.some(requiresWorkspaceWrite)) {
        return "ask";
      }
      const assessment = this.policy?.assess(request);
      if (assessment === undefined || assessment.decision === "ask") {
        return "ask";
      }
      if (assessment.decision === "deny") {
        await this.auditDeny({
          capability: assessment.capability,
          decision: "deny",
          event: "permission.deny",
          policyDigest: this.policy?.digest,
          reason: assessment.reason,
          resourceDigest: resourceDigest(request.subject),
        });
        throw policyDenied(assessment.reason, assessment.capability);
      }

      await this.auditRequired({
        capabilities: Object.freeze([...request.capabilities].toSorted()),
        decision: "allow",
        event: "permission.allow",
        policyDigest: this.policy?.digest,
        reason: assessment.reason,
        resourceDigest: resourceDigest(request.subject),
      });
      return "allow";
    };
  }

  public permissionApprovalHandler(): PermissionApprovalHandler {
    return async (request) => {
      throw approvalRequired(
        `Permission ${request.policyId} requires explicit Managed Policy authorization.`,
        request.capabilities[0],
      );
    };
  }

  public workspaceAccessApprovalHandler(): WorkspaceWriteAccessApprovalHandler {
    return async () => {
      if (this.accessMode !== "read-write") {
        throw approvalRequired(
          "Workspace write access is not covered by the current read-only Workspace Trust.",
          "workspace.write",
        );
      }
      const assessment = this.policy?.grantsWorkspaceWrite();
      if (assessment === undefined || assessment.decision === "ask") {
        throw approvalRequired(
          "Workspace write access requires explicit Managed Policy authorization.",
          "workspace.write",
        );
      }
      if (assessment.decision === "deny") {
        await this.auditDeny({
          capability: "workspace.write",
          decision: "deny",
          event: "permission.deny",
          policyDigest: this.policy?.digest,
          reason: assessment.reason,
        });
        throw policyDenied(assessment.reason, "workspace.write");
      }
      await this.auditRequired({
        capability: "workspace.write",
        decision: "allow",
        event: "permission.allow",
        policyDigest: this.policy?.digest,
        reason: assessment.reason,
      });
      return { decision: "allow", persistence: "session" };
    };
  }

  private async auditLowRisk(
    record: Omit<PolicyAuditRecord, "sessionId" | "timestamp" | "workspaceId">,
  ): Promise<void> {
    try {
      await this.writeAudit(record);
    } catch {
      this.diagnosticEntries.push({
        code: "CLI_AUDIT_DEGRADED",
        message: "Unable to persist low-risk automation audit record.",
      });
    }
  }

  private async auditDeny(
    record: Omit<PolicyAuditRecord, "sessionId" | "timestamp" | "workspaceId">,
  ): Promise<void> {
    await this.writeAudit(record).catch(() => undefined);
  }

  private async auditRequired(
    record: Omit<PolicyAuditRecord, "sessionId" | "timestamp" | "workspaceId">,
  ): Promise<void> {
    try {
      await this.writeAudit(record);
    } catch {
      throw policyDenied(
        "Managed Policy authorization was denied because its audit record could not be persisted.",
        record.capability,
      );
    }
  }

  private writeAudit(
    record: Omit<PolicyAuditRecord, "sessionId" | "timestamp" | "workspaceId">,
  ): Promise<void> {
    return this.audit.append({
      ...record,
      sessionId: this.sessionId,
      timestamp: this.now().toISOString(),
      workspaceId: this.workspaceId,
    });
  }
}

export async function loadNonInteractiveAutomation(
  options: LoadNonInteractiveAutomationOptions,
): Promise<NonInteractiveAutomation> {
  const workspaceId = resolve(options.workspaceDir);
  const policy =
    options.policyFilePath === undefined
      ? undefined
      : await loadManagedPolicy({
          filePath: options.policyFilePath,
          workspaceDir: workspaceId,
        });
  const answers =
    options.answersFilePath === undefined
      ? undefined
      : await loadAutomationAnswers(options.answersFilePath);
  const homeDir = resolve(options.homeDir ?? homedir());
  const audit = new PolicyAuditLog({
    filePath: options.auditFilePath ?? join(homeDir, ".yiku", "audit", "cli-policy.ndjson"),
    ...(policy?.document.auditRetentionDays === undefined
      ? {}
      : { retentionDays: policy.document.auditRetentionDays }),
  });
  return new NonInteractiveAutomation({
    accessMode: options.accessMode,
    ...(answers === undefined ? {} : { answers }),
    audit,
    ...(policy === undefined ? {} : { policy }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    workspaceId: policy?.workspaceId ?? workspaceId,
  });
}

type NormalizedQuestion = ReturnType<typeof normalizeUserQuestionRequest>["questions"][number];
type StructuredAnswer = Extract<
  UserQuestionResponse,
  { readonly answers: readonly unknown[] }
>["answers"][number];

function resolveAnswer(
  question: NormalizedQuestion,
  configured: AutomationAnswer,
  questionIndex: number,
  questionKey: string,
): StructuredAnswer {
  if ("value" in configured) {
    if (!question.freeText && !question.allowCustom) {
      throw needsInput(`Question ${questionKey} does not allow a free-text answer.`, questionKey);
    }
    return {
      answers: [configured.value],
      questionIndex,
      selectedIndexes: [],
    };
  }

  const optionIds = "optionId" in configured ? [configured.optionId] : configured.optionIds;
  if (!question.multiSelect && optionIds.length !== 1) {
    throw needsInput(`Question ${questionKey} requires exactly one option.`, questionKey);
  }
  const selectedIndexes = optionIds.map((optionId) => {
    const index = question.options.findIndex((option) => option.optionId === optionId);
    if (index === -1) {
      throw needsInput(
        `Configured option ${optionId} is not valid for question ${questionKey}.`,
        questionKey,
      );
    }
    return index;
  });
  return {
    answers: selectedIndexes.map((index) => question.options[index]?.label ?? ""),
    questionIndex,
    selectedIndexes,
  };
}

function normalizeQuestionResponse(
  source: "legacy" | "structured",
  answers: readonly StructuredAnswer[],
): UserQuestionResponse {
  if (source === "structured") {
    return { answers };
  }
  const answer = answers[0];
  if (answer === undefined) {
    throw needsInput("Legacy question requires interactive input.");
  }
  return {
    answer: answer.answers[0] ?? "",
    ...(answer.selectedIndexes[0] === undefined
      ? {}
      : { selectedIndex: answer.selectedIndexes[0] }),
  };
}

function trustedRecommendedIndex(
  options: NormalizedQuestion["options"],
  recommendedOptionId: string | undefined,
): number | undefined {
  if (recommendedOptionId === undefined) {
    return undefined;
  }
  const index = options.findIndex(
    (option) => option.optionId === recommendedOptionId && option.recommended === true,
  );
  return index === -1 ? undefined : index;
}

function matchesTrustedManifest(
  question: NormalizedQuestion,
  manifest: TrustedQuestionManifest,
): boolean {
  const optionIds = question.options.flatMap((option) =>
    option.optionId === undefined ? [] : [option.optionId],
  );
  const recommendedOptionIds = question.options.flatMap((option) =>
    option.recommended === true && option.optionId !== undefined ? [option.optionId] : [],
  );
  return (
    question.allowAutoRecommended === manifest.allowAutoRecommended &&
    question.preconfiguredAnswer === manifest.preconfiguredAnswer &&
    question.risk === manifest.risk &&
    question.multiSelect === manifest.multiSelect &&
    optionIds.length === question.options.length &&
    optionIds.length === manifest.optionIds.length &&
    optionIds.every((optionId) => manifest.optionIds.includes(optionId)) &&
    recommendedOptionIds.length === (manifest.recommendedOptionId === undefined ? 0 : 1) &&
    recommendedOptionIds[0] === manifest.recommendedOptionId
  );
}

function resourceDigest(resource: string): string | undefined {
  const normalized = resource.trim().replaceAll(/\s+/gu, " ");
  return normalized ? sha256(normalized) : undefined;
}

export function isCliAutomationError(error: unknown): error is CliAutomationError {
  return error instanceof CliAutomationError;
}

function requiresWorkspaceWrite(capability: string): boolean {
  return capability.startsWith("workspace.") && capability !== "workspace.read";
}
