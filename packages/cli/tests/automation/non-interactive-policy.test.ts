import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionRequest } from "@yiku/agent-orchestrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationAnswers } from "../../src/automation/answer-file.js";
import { ManagedPolicy } from "../../src/automation/managed-policy.js";
import {
  loadNonInteractiveAutomation,
  NonInteractiveAutomation,
} from "../../src/automation/non-interactive-policy.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("NonInteractiveAutomation", () => {
  it("does not trust model-declared automatic recommendations without a Host manifest", async () => {
    const automation = new NonInteractiveAutomation({
      audit: { append: vi.fn(async () => undefined) },
      sessionId: "session-1",
      workspaceId: "/workspace",
    });

    await expect(
      automation.questionHandler()({
        questions: [
          {
            allowAutoRecommended: true,
            header: "Format",
            multiSelect: false,
            options: [
              {
                description: "Machine readable",
                label: "JSON",
                optionId: "json",
                recommended: true,
              },
              {
                description: "Human readable",
                label: "Text",
                optionId: "text",
              },
            ],
            question: "Choose output.",
            questionKey: "cli.output.format@1",
            risk: "preference",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CLI_NEEDS_INPUT",
    });
  });

  it("requires the dynamic question to exactly match preconfiguration metadata", async () => {
    const manifest = {
      allowAutoRecommended: false,
      multiSelect: false,
      optionIds: ["json", "text"],
      preconfiguredAnswer: true,
      questionKey: "cli.output.format@1",
      risk: "required-input" as const,
    };
    const automation = new NonInteractiveAutomation({
      answers: new AutomationAnswers(
        "/answers.json",
        new Map([["cli.output.format@1", { optionId: "json" }]]),
        new Map([[manifest.questionKey, manifest]]),
      ),
      audit: { append: vi.fn(async () => undefined) },
      sessionId: "session-1",
      workspaceId: "/workspace",
    });

    await expect(
      automation.questionHandler()({
        questions: [
          {
            header: "Format",
            multiSelect: false,
            options: [
              { description: "Machine readable", label: "JSON", optionId: "json" },
              { description: "Human readable", label: "Text", optionId: "text" },
            ],
            preconfiguredAnswer: false,
            question: "Choose output.",
            questionKey: "cli.output.format@1",
            risk: "required-input",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CLI_NEEDS_INPUT",
    });
  });

  it("allows only complete Managed Policy capability grants and audits them", async () => {
    const audit = { append: vi.fn(async () => undefined) };
    const automation = new NonInteractiveAutomation({
      accessMode: "read-write",
      audit,
      policy: policy({
        denies: [],
        grants: [
          { capability: "process.execute", workspaceId: "/workspace" },
          { capability: "workspace.write", workspaceId: "/workspace" },
        ],
        schemaVersion: 1,
      }),
      sessionId: "session-1",
      workspaceId: "/workspace",
    });

    await expect(
      automation.permissionAssessmentHandler()(
        request(["process.execute", "workspace.write"]),
        "ask",
      ),
    ).resolves.toBe("allow");
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "allow",
        event: "permission.allow",
        resourceDigest: expect.any(String),
      }),
    );
  });

  it("distinguishes missing approval from explicit policy denial", async () => {
    const missing = new NonInteractiveAutomation({
      audit: { append: vi.fn(async () => undefined) },
      sessionId: "session-1",
      workspaceId: "/workspace",
    });
    await expect(
      missing.permissionApprovalHandler()(request(["process.execute"])),
    ).rejects.toMatchObject({
      code: "CLI_APPROVAL_REQUIRED",
      exitCode: 5,
    });
    await expect(missing.permissionApprovalHandler()(request([]))).rejects.toMatchObject({
      code: "CLI_APPROVAL_REQUIRED",
      details: {},
    });

    const denied = new NonInteractiveAutomation({
      accessMode: "read-write",
      audit: { append: vi.fn(async () => undefined) },
      policy: policy({
        denies: [{ capability: "process.execute", workspaceId: "/workspace" }],
        grants: [{ capability: "process.execute", workspaceId: "/workspace" }],
        schemaVersion: 1,
      }),
      sessionId: "session-1",
      workspaceId: "/workspace",
    });
    await expect(
      denied.permissionAssessmentHandler()(request(["process.execute"]), "ask"),
    ).rejects.toMatchObject({
      code: "CLI_POLICY_DENIED",
      exitCode: 4,
    });
  });

  it("fails closed when a high-risk allow cannot be audited", async () => {
    const automation = new NonInteractiveAutomation({
      accessMode: "read-write",
      audit: {
        append: vi.fn(async () => {
          throw new Error("disk full");
        }),
      },
      policy: policy({
        denies: [],
        grants: [{ capability: "process.execute", workspaceId: "/workspace" }],
        schemaVersion: 1,
      }),
      sessionId: "session-1",
      workspaceId: "/workspace",
    });

    await expect(
      automation.permissionAssessmentHandler()(request(["process.execute"]), "ask"),
    ).rejects.toMatchObject({
      code: "CLI_POLICY_DENIED",
      exitCode: 4,
    });
  });

  it("does not let Managed Policy broaden read-only Workspace Trust", async () => {
    const automation = new NonInteractiveAutomation({
      accessMode: "read-only",
      audit: { append: vi.fn(async () => undefined) },
      policy: policy({
        denies: [],
        grants: [
          { capability: "process.execute", workspaceId: "/workspace" },
          { capability: "workspace.write", workspaceId: "/workspace" },
        ],
        schemaVersion: 1,
      }),
      sessionId: "session-1",
      workspaceId: "/workspace",
    });

    await expect(
      automation.permissionAssessmentHandler()(
        request(["process.execute", "workspace.write"]),
        "ask",
      ),
    ).resolves.toBe("ask");
    await expect(
      automation.workspaceAccessApprovalHandler()({
        action: "edit",
        subject: "src/index.ts",
        workspaceId: "workspace-hash",
      }),
    ).rejects.toMatchObject({
      code: "CLI_APPROVAL_REQUIRED",
    });
  });

  it("resolves preconfigured multi-select, text, and recommended answers", async () => {
    const audit = { append: vi.fn(async () => undefined) };
    const manifests = [
      questionManifest("code.checks.enabled@1", ["test", "lint"], {
        multiSelect: true,
      }),
      questionManifest("code.release.note@1", ["approved", "custom"], {
        preconfiguredAnswer: true,
        risk: "required-input",
      }),
      questionManifest("cli.output.format@1", ["json", "text"], {
        allowAutoRecommended: true,
        recommendedOptionId: "json",
      }),
    ] as const;
    const automation = new NonInteractiveAutomation({
      answers: new AutomationAnswers(
        "/answers.json",
        new Map([
          ["code.checks.enabled@1", { optionIds: ["test", "lint"] }],
          ["code.release.note@1", { value: "Approved release note." }],
        ]),
        new Map(manifests.map((manifest) => [manifest.questionKey, manifest])),
      ),
      audit,
      questionManifests: manifests,
      sessionId: "session-1",
      workspaceId: "/workspace",
    });

    await expect(
      automation.questionHandler()({
        questions: [
          {
            header: "Checks",
            multiSelect: true,
            options: [
              { description: "Run tests", label: "Test", optionId: "test" },
              { description: "Run lint", label: "Lint", optionId: "lint" },
            ],
            question: "Choose checks.",
            questionKey: "code.checks.enabled@1",
            risk: "preference",
          },
          {
            header: "Release",
            multiSelect: false,
            options: [
              { description: "Approved", label: "Approved", optionId: "approved" },
              { description: "Custom", label: "Custom", optionId: "custom" },
            ],
            preconfiguredAnswer: true,
            question: "Provide the release note.",
            questionKey: "code.release.note@1",
            risk: "required-input",
          },
          {
            allowAutoRecommended: true,
            header: "Format",
            multiSelect: false,
            options: [
              {
                description: "Machine readable",
                label: "JSON",
                optionId: "json",
                recommended: true,
              },
              { description: "Human readable", label: "Text", optionId: "text" },
            ],
            question: "Choose output.",
            questionKey: "cli.output.format@1",
            risk: "preference",
          },
        ],
      }),
    ).resolves.toEqual({
      answers: [
        { answers: ["Test", "Lint"], questionIndex: 0, selectedIndexes: [0, 1] },
        {
          answers: ["Approved release note."],
          questionIndex: 1,
          selectedIndexes: [],
        },
        { answers: ["JSON"], questionIndex: 2, selectedIndexes: [0] },
      ],
    });
    expect(audit.append).toHaveBeenCalledTimes(3);
    expect(automation.diagnostics()).toEqual([]);
  });

  it("rejects sensitive, missing, and invalid configured question answers", async () => {
    const empty = new NonInteractiveAutomation({
      audit: { append: vi.fn(async () => undefined) },
      sessionId: "session-1",
      workspaceId: "/workspace",
    });
    for (const risk of ["permission", "secret"] as const) {
      await expect(
        empty.questionHandler()({
          questions: [
            {
              header: "Risk",
              multiSelect: false,
              options: [
                { description: "Continue", label: "Yes", optionId: "yes" },
                { description: "Stop", label: "No", optionId: "no" },
              ],
              question: "Continue?",
              questionKey: `code.risk.${risk}@1`,
              risk,
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "CLI_NEEDS_INPUT" });
    }

    const manifest = questionManifest("cli.output.format@1", ["json", "text"]);
    for (const answer of [{ optionId: "xml" }, { optionIds: ["json", "text"] }]) {
      const automation = new NonInteractiveAutomation({
        answers: new AutomationAnswers(
          "/answers.json",
          new Map([[manifest.questionKey, answer]]),
          new Map([[manifest.questionKey, manifest]]),
        ),
        audit: { append: vi.fn(async () => undefined) },
        sessionId: "session-1",
        workspaceId: "/workspace",
      });
      await expect(
        automation.questionHandler()({
          questions: [
            {
              header: "Format",
              multiSelect: false,
              options: [
                { description: "Machine readable", label: "JSON", optionId: "json" },
                { description: "Human readable", label: "Text", optionId: "text" },
              ],
              question: "Choose output.",
              questionKey: manifest.questionKey,
              risk: "preference",
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "CLI_NEEDS_INPUT" });
    }
  });

  it("preserves runtime denials and handles missing policy decisions", async () => {
    const automation = new NonInteractiveAutomation({
      accessMode: "read-write",
      audit: { append: vi.fn(async () => undefined) },
      sessionId: "session-1",
      workspaceId: "/workspace",
    });

    await expect(
      automation.permissionAssessmentHandler()(request(["process.execute"]), "deny"),
    ).rejects.toMatchObject({
      code: "CLI_POLICY_DENIED",
      details: { capability: "process.execute" },
    });
    await expect(
      automation.permissionAssessmentHandler()(request(["process.execute"]), "ask"),
    ).resolves.toBe("ask");
    await expect(
      automation.workspaceAccessApprovalHandler()({
        action: "edit",
        subject: "src/index.ts",
        workspaceId: "workspace-hash",
      }),
    ).rejects.toMatchObject({ code: "CLI_APPROVAL_REQUIRED" });
  });

  it("applies allow and deny decisions to workspace access", async () => {
    const requestInput = {
      action: "edit",
      subject: "src/index.ts",
      workspaceId: "workspace-hash",
    };
    const audit = { append: vi.fn(async () => undefined) };
    const allowed = new NonInteractiveAutomation({
      accessMode: "read-write",
      audit,
      policy: policy({
        denies: [],
        grants: [{ capability: "workspace.write", workspaceId: "/workspace" }],
        schemaVersion: 1,
      }),
      sessionId: "session-1",
      workspaceId: "/workspace",
    });
    await expect(allowed.workspaceAccessApprovalHandler()(requestInput)).resolves.toEqual({
      decision: "allow",
      persistence: "session",
    });

    const denied = new NonInteractiveAutomation({
      accessMode: "read-write",
      audit,
      policy: policy({
        denies: [{ capability: "workspace.write", workspaceId: "/workspace" }],
        grants: [],
        schemaVersion: 1,
      }),
      sessionId: "session-1",
      workspaceId: "/workspace",
    });
    await expect(denied.workspaceAccessApprovalHandler()(requestInput)).rejects.toMatchObject({
      code: "CLI_POLICY_DENIED",
    });
  });

  it("loads explicit answer, policy, retention, audit, and session options", async () => {
    const root = await mkdtemp(join(tmpdir(), "yiku-non-interactive-load-"));
    directories.push(root);
    const workspaceDir = join(root, "workspace");
    const policyDir = join(root, "policy");
    const homeDir = join(root, "home");
    await Promise.all([
      mkdir(workspaceDir, { mode: 0o700 }),
      mkdir(policyDir, { mode: 0o700 }),
      mkdir(homeDir, { mode: 0o700 }),
    ]);
    const workspaceId = await realpath(workspaceDir);
    const policyFilePath = join(policyDir, "policy.json");
    const answersFilePath = join(policyDir, "answers.json");
    await writeFile(
      policyFilePath,
      JSON.stringify({
        auditRetentionDays: 30,
        denies: [],
        grants: [{ capability: "workspace.read", workspaceId }],
        schemaVersion: 1,
      }),
      { mode: 0o600 },
    );
    await writeFile(
      answersFilePath,
      JSON.stringify({
        answers: {},
        manifests: [],
        schemaVersion: 1,
      }),
      { mode: 0o600 },
    );

    const automation = await loadNonInteractiveAutomation({
      accessMode: "read-only",
      answersFilePath,
      auditFilePath: join(homeDir, "audit.ndjson"),
      homeDir,
      policyFilePath,
      sessionId: "session-explicit",
      workspaceDir,
    });

    expect(automation.diagnostics()).toEqual([]);
    await expect(
      automation.permissionAssessmentHandler()(
        {
          ...request(["workspace.read"]),
          subject: " ",
        },
        "ask",
      ),
    ).resolves.toBe("allow");
  });

  it("handles required input and optional recommendations without configured answers", async () => {
    const requiredManifest = questionManifest("code.architecture.choice@1", ["a", "b"], {
      risk: "required-input",
    });
    const optionalRecommendation = questionManifest("cli.output.optional@1", ["json", "text"], {
      allowAutoRecommended: true,
    });
    const automation = new NonInteractiveAutomation({
      audit: { append: vi.fn(async () => undefined) },
      questionManifests: [requiredManifest, optionalRecommendation],
      sessionId: "session-1",
      workspaceId: "/workspace",
    });

    for (const input of [
      {
        header: "Choice",
        multiSelect: false,
        options: [
          { description: "A", label: "A", optionId: "a" },
          { description: "B", label: "B", optionId: "b" },
        ],
        question: "Choose architecture.",
        questionKey: requiredManifest.questionKey,
        risk: "required-input" as const,
      },
      {
        allowAutoRecommended: true,
        header: "Format",
        multiSelect: false,
        options: [
          { description: "JSON", label: "JSON", optionId: "json" },
          { description: "Text", label: "Text", optionId: "text" },
        ],
        question: "Choose optional output.",
        questionKey: optionalRecommendation.questionKey,
        risk: "preference" as const,
      },
    ]) {
      await expect(
        automation.questionHandler()({
          questions: [input],
        }),
      ).rejects.toMatchObject({ code: "CLI_NEEDS_INPUT" });
    }
  });
});

function policy(document: ConstructorParameters<typeof ManagedPolicy>[1]): ManagedPolicy {
  return new ManagedPolicy("policy-digest", document, "/policy.json", "/workspace");
}

function request(capabilities: readonly string[]): PermissionRequest {
  return {
    action: "execute",
    capabilities,
    normalizedAction: "pnpm test",
    policyId: "test-command",
    reason: "Test command requires approval.",
    risk: "medium",
    subject: "pnpm test",
    toolName: "bashTool",
    workspaceId: "workspace-hash",
  };
}

function questionManifest(
  questionKey: string,
  optionIds: readonly string[],
  overrides: Partial<{
    readonly allowAutoRecommended: boolean;
    readonly multiSelect: boolean;
    readonly preconfiguredAnswer: boolean;
    readonly recommendedOptionId: string;
    readonly risk: "preference" | "required-input";
  }> = {},
) {
  return {
    allowAutoRecommended: false,
    multiSelect: false,
    optionIds,
    preconfiguredAnswer: false,
    questionKey,
    risk: "preference" as const,
    ...overrides,
  };
}
