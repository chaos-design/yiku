import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionRequest } from "@yiku/agent-orchestrator";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadManagedPolicy,
  ManagedPolicy,
  parseManagedPolicyDocument,
} from "../../src/automation/managed-policy.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("ManagedPolicy", () => {
  it("requires every requested capability and applies deny precedence", async () => {
    const fixture = await createFixture();
    const policy = await writePolicy(fixture, {
      denies: [],
      grants: [
        { capability: "process.execute", workspaceId: fixture.workspaceDir },
        { capability: "workspace.write", workspaceId: fixture.workspaceDir },
      ],
      schemaVersion: 1,
    });
    const loaded = await loadManagedPolicy({
      filePath: policy,
      workspaceDir: fixture.workspaceDir,
    });

    expect(loaded.assess(permissionRequest(["process.execute", "workspace.write"]))).toMatchObject({
      decision: "allow",
    });
    expect(loaded.assess(permissionRequest(["process.execute", "shell.opaque"]))).toMatchObject({
      decision: "ask",
    });
    expect(
      loaded.assess({
        ...permissionRequest(["process.execute"]),
        metadata: { commandTruncated: "true" },
      }),
    ).toMatchObject({ decision: "ask" });

    const deniedPath = await writePolicy(fixture, {
      denies: [{ capability: "workspace.write", workspaceId: fixture.workspaceDir }],
      grants: [
        { capability: "process.execute", workspaceId: fixture.workspaceDir },
        { capability: "workspace.write", workspaceId: fixture.workspaceDir },
      ],
      schemaVersion: 1,
    });
    const denied = await loadManagedPolicy({
      filePath: deniedPath,
      workspaceDir: fixture.workspaceDir,
    });
    expect(denied.assess(permissionRequest(["process.execute", "workspace.write"]))).toMatchObject({
      capability: "workspace.write",
      decision: "deny",
    });
  });

  it("rejects policies inside the Workspace, symlinks, and writable files", async () => {
    const fixture = await createFixture();
    const document = {
      denies: [],
      grants: [],
      schemaVersion: 1,
    };
    const inside = join(fixture.workspaceDir, "policy.json");
    await writeFile(inside, JSON.stringify(document), { mode: 0o600 });
    await expect(
      loadManagedPolicy({ filePath: inside, workspaceDir: fixture.workspaceDir }),
    ).rejects.toThrow("inside the Workspace");

    const target = await writePolicy(fixture, document);
    const link = join(fixture.policyDir, "policy-link.json");
    await symlink(target, link);
    await expect(
      loadManagedPolicy({ filePath: link, workspaceDir: fixture.workspaceDir }),
    ).rejects.toThrow("not trusted");

    await chmod(target, 0o622);
    await expect(
      loadManagedPolicy({ filePath: target, workspaceDir: fixture.workspaceDir }),
    ).rejects.toThrow("not trusted");
  });

  it("validates scoped resources, dates, and unknown fields", () => {
    expect(() =>
      parseManagedPolicyDocument({
        denies: [],
        grants: [
          {
            capability: "external.request",
            workspaceId: "/workspace",
          },
        ],
        schemaVersion: 1,
      }),
    ).toThrow("requires resource scope");
    expect(() =>
      parseManagedPolicyDocument({
        denies: [],
        grants: [
          {
            capability: "mcp.invoke",
            resource: "*",
            workspaceId: "/workspace",
          },
        ],
        schemaVersion: 1,
      }),
    ).toThrow("must not contain wildcards");
    expect(() =>
      parseManagedPolicyDocument({
        denies: [],
        grants: [],
        schemaVersion: 1,
        unknown: true,
      }),
    ).toThrow("unknown field");
  });

  it("maps every supported runtime capability and resource scope", () => {
    const workspaceId = "/workspace";
    const rules = [
      ["credential.api-key", "credential.use", "vault/key"],
      ["external.mcp.invoke", "mcp.invoke", "github/create"],
      ["network.connect", "external.request", "api.example.test"],
      ["package.publish", "external.publish", "package-name"],
      ["process.execute", "process.execute", "pnpm test"],
      ["workspace.delete", "workspace.delete", undefined],
      ["workspace.read", "workspace.read", undefined],
      ["workspace.edit", "workspace.write", undefined],
    ] as const;
    const policy = new ManagedPolicy(
      "digest",
      {
        denies: [],
        grants: rules.map(([, capability, resource]) => ({
          capability,
          ...(resource === undefined ? {} : { resource }),
          workspaceId,
        })),
        schemaVersion: 1,
      },
      "/policy.json",
      workspaceId,
    );

    for (const [runtimeCapability, , resource] of rules) {
      expect(
        policy.assess({
          ...permissionRequest([runtimeCapability]),
          subject: resource ?? "workspace",
        }),
      ).toMatchObject({ decision: "allow" });
    }
    expect(policy.assess(permissionRequest([]))).toMatchObject({ decision: "ask" });
  });

  it("applies workspace-write, expiry, workspace, and resource constraints", () => {
    const workspaceId = "/workspace";
    const now = new Date("2026-08-20T00:00:00.000Z");
    const policy = new ManagedPolicy(
      "digest",
      {
        denies: [],
        grants: [
          {
            capability: "workspace.write",
            expiresAt: "2026-08-21T00:00:00.000Z",
            workspaceId,
          },
          {
            capability: "external.request",
            resource: "api.example.test",
            workspaceId,
          },
        ],
        schemaVersion: 1,
      },
      "/policy.json",
      workspaceId,
    );

    expect(policy.grantsWorkspaceWrite(now)).toMatchObject({ decision: "allow" });
    expect(policy.grantsWorkspaceWrite(new Date("2026-08-22T00:00:00.000Z"))).toMatchObject({
      decision: "ask",
    });
    expect(
      policy.assess(
        {
          ...permissionRequest(["network.connect"]),
          subject: "other.example.test",
        },
        now,
      ),
    ).toMatchObject({ decision: "ask" });

    const denied = new ManagedPolicy(
      "digest",
      {
        denies: [{ capability: "workspace.write", workspaceId }],
        grants: [],
        schemaVersion: 1,
      },
      "/policy.json",
      workspaceId,
    );
    expect(denied.grantsWorkspaceWrite(now)).toMatchObject({ decision: "deny" });
  });

  it("rejects malformed policy fields and rules", () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [{ denies: [], grants: [], schemaVersion: 2 }, "schemaVersion must be 1"],
      [{ denies: [], grants: {}, schemaVersion: 1 }, "grants must be an array"],
      [{ denies: {}, grants: [], schemaVersion: 1 }, "denies must be an array"],
      [
        {
          auditRetentionDays: 29,
          denies: [],
          grants: [],
          schemaVersion: 1,
        },
        "between 30 and 365",
      ],
      [
        {
          denies: [],
          grants: [{ capability: "unknown", workspaceId: "/workspace" }],
          schemaVersion: 1,
        },
        "not a supported Managed Capability",
      ],
      [
        {
          denies: [],
          grants: [{ capability: "workspace.read", workspaceId: "relative" }],
          schemaVersion: 1,
        },
        "normalized absolute path",
      ],
      [
        {
          denies: [],
          grants: [
            {
              capability: "workspace.read",
              expiresAt: "not-a-date",
              workspaceId: "/workspace",
            },
          ],
          schemaVersion: 1,
        },
        "must be an ISO date",
      ],
      [
        {
          denies: [],
          grants: [
            {
              capability: "workspace.read",
              resource: " ",
              workspaceId: "/workspace",
            },
          ],
          schemaVersion: 1,
        },
        "must be a non-empty string",
      ],
      [
        {
          denies: [],
          grants: [{ capability: "workspace.read", unknown: true, workspaceId: "/workspace" }],
          schemaVersion: 1,
        },
        "unknown field",
      ],
      [{ denies: [], grants: [null], schemaVersion: 1 }, "must be an object"],
      [null, "Managed Policy must be an object"],
    ];

    for (const [document, message] of cases) {
      expect(() => parseManagedPolicyDocument(document)).toThrow(message);
    }

    expect(
      parseManagedPolicyDocument({
        auditRetentionDays: 90,
        grants: [],
        schemaVersion: 1,
      }),
    ).toEqual({
      auditRetentionDays: 90,
      denies: [],
      grants: [],
      schemaVersion: 1,
    });
    expect(
      parseManagedPolicyDocument({
        denies: [],
        grants: [
          {
            capability: "workspace.read",
            expiresAt: "2026-08-21T00:00:00.000Z",
            resource: "repository",
            workspaceId: "/workspace",
          },
        ],
        schemaVersion: 1,
      }),
    ).toMatchObject({
      grants: [
        {
          expiresAt: "2026-08-21T00:00:00.000Z",
          resource: "repository",
        },
      ],
    });
  });

  it("rejects invalid JSON, oversized policies, and writable parent directories", async () => {
    const invalid = await createFixture();
    await expect(
      loadManagedPolicy({
        filePath: await writePolicySource(invalid, "{"),
        workspaceDir: invalid.workspaceDir,
      }),
    ).rejects.toThrow("Unable to parse Managed Policy");

    const oversized = await createFixture();
    await expect(
      loadManagedPolicy({
        filePath: await writePolicySource(oversized, " ".repeat(1024 * 1024 + 1)),
        workspaceDir: oversized.workspaceDir,
      }),
    ).rejects.toThrow("exceeds");

    const writable = await createFixture();
    const writablePath = await writePolicy(writable, {
      denies: [],
      grants: [],
      schemaVersion: 1,
    });
    await chmod(writable.policyDir, 0o777);
    await expect(
      loadManagedPolicy({ filePath: writablePath, workspaceDir: writable.workspaceDir }),
    ).rejects.toThrow("parent directories");
  });
});

interface Fixture {
  readonly policyDir: string;
  readonly workspaceDir: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "yiku-managed-policy-"));
  directories.push(root);
  const workspaceDir = join(root, "workspace");
  const policyDir = join(root, "policy");
  await mkdir(workspaceDir, { mode: 0o700 });
  await mkdir(policyDir, { mode: 0o700 });
  return {
    policyDir,
    workspaceDir: await realpath(workspaceDir),
  };
}

async function writePolicy(fixture: Fixture, document: unknown): Promise<string> {
  return writePolicySource(fixture, `${JSON.stringify(document)}\n`);
}

async function writePolicySource(fixture: Fixture, source: string): Promise<string> {
  const path = join(fixture.policyDir, `policy-${Date.now()}-${Math.random()}.json`);
  await writeFile(path, source, { mode: 0o600 });
  return path;
}

function permissionRequest(capabilities: readonly string[]): PermissionRequest {
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
