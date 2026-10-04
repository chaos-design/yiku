import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDefaultPermissionProfileDocument,
  PermissionProfileValidationError,
} from "../../src/permission/profile-schema.js";
import { PermissionProfileStore } from "../../src/permission/profile-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("PermissionProfileStore", () => {
  it("resolves the default Home permission path without writing", () => {
    const store = new PermissionProfileStore();

    expect(store.filePath).toMatch(/\.yiku\/permission\/global\.json$/u);
  });

  it("generates a private default profile", async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, ".yiku", "permission", "global.json");
    const store = new PermissionProfileStore({ filePath });

    await expect(store.load()).resolves.toMatchObject({
      activeProfile: "default",
      profiles: {
        default: {
          approval: {
            policyRules: {
              "known-low-risk-command": "allow",
              "workspace-file-write": "allow",
            },
          },
          authorization: {
            ttlDays: 7,
          },
        },
      },
    });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(filePath))).mode & 0o777).toBe(0o700);
  });

  it("persists the legacy default network migration", async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, ".yiku", "permission", "global.json");
    const document = createDefaultPermissionProfileDocument();
    const profile = document.profiles.default;
    if (profile === undefined) {
      throw new Error("Expected default permission profile.");
    }
    await writeDocument(filePath, {
      ...document,
      _migrationVersion: 1,
      profiles: {
        ...document.profiles,
        default: {
          ...profile,
          network: { default: "deny" },
        },
      },
    });

    await expect(new PermissionProfileStore({ filePath }).load()).resolves.toMatchObject({
      _migrationVersion: 2,
      profiles: {
        default: {
          network: { default: "allow" },
        },
      },
    });
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      _migrationVersion: 2,
      profiles: {
        default: {
          network: { default: "allow" },
        },
      },
    });
  });

  it("persists read-only and read-write Workspace authorizations with profile TTL", async () => {
    const root = await temporaryDirectory();
    const workspaceDir = join(root, "workspace");
    const otherWorkspaceDir = join(root, "other-workspace");
    const filePath = join(root, "home", ".yiku", "permission", "global.json");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(otherWorkspaceDir, { recursive: true });
    await writeDocument(filePath, profileWithTtl(2));
    const store = new PermissionProfileStore({ filePath });
    const now = new Date("2026-08-09T00:00:00.000Z");

    await expect(store.authorizeWorkspace(workspaceDir, "read-only", now)).resolves.toMatchObject({
      accessMode: "read-only",
      expiresAt: "2026-08-11T00:00:00.000Z",
    });
    await expect(store.getWorkspaceAuthorization(workspaceDir, now)).resolves.toMatchObject({
      accessMode: "read-only",
    });

    await store.authorizeWorkspace(otherWorkspaceDir, "read-write", now);
    await store.authorizeWorkspace(workspaceDir, "read-write", now);
    await expect(store.getWorkspaceAuthorization(workspaceDir, now)).resolves.toMatchObject({
      accessMode: "read-write",
    });
    await expect(
      store.getWorkspaceAuthorization(workspaceDir, new Date("2026-08-11T00:00:00.001Z")),
    ).resolves.toBeUndefined();
    await expect(store.getWorkspaceAuthorization(otherWorkspaceDir, now)).resolves.toMatchObject({
      accessMode: "read-write",
    });
  });

  it("serializes concurrent policy updates without dropping rules", async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, ".yiku", "permission", "global.json");
    const store = new PermissionProfileStore({ filePath });
    await store.load();

    await Promise.all([
      store.setPolicyRule("workspace-delete", "deny"),
      store.setPolicyRule("workspace-edit", "allow"),
    ]);

    await expect(store.load()).resolves.toMatchObject({
      profiles: {
        default: {
          approval: {
            policyRules: {
              "workspace-delete": "deny",
              "workspace-edit": "allow",
            },
          },
        },
      },
    });
  });

  it("fails closed for a corrupt profile and can reset it explicitly", async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, "global.json");
    await writeFile(filePath, "{", "utf8");
    const store = new PermissionProfileStore({ filePath });

    await expect(store.load()).rejects.toBeInstanceOf(PermissionProfileValidationError);
    await expect(store.reset()).resolves.toMatchObject({ activeProfile: "default" });
  });

  it("rejects invalid schemas and empty Policy IDs", async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, "global.json");
    await writeFile(filePath, JSON.stringify({ activeProfile: "missing" }), "utf8");
    const store = new PermissionProfileStore({ filePath });

    await expect(store.load()).rejects.toBeInstanceOf(PermissionProfileValidationError);
    await expect(store.setPolicyRule(" ", "allow")).rejects.toThrow("Policy ID must be non-empty");
  });

  it("uses resolved paths when a Workspace does not exist yet", async () => {
    const root = await temporaryDirectory();
    const workspaceDir = join(root, "missing-workspace");
    const store = new PermissionProfileStore({
      filePath: join(root, "global.json"),
    });
    const now = new Date("2026-08-09T00:00:00.000Z");

    await store.authorizeWorkspace(workspaceDir, "read-only", now);
    await expect(store.getWorkspaceAuthorization(workspaceDir, now)).resolves.toMatchObject({
      accessMode: "read-only",
      workspaceDir,
    });
  });

  it("cleans up a failed atomic replacement", async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, "global.json");
    await mkdir(filePath);
    const store = new PermissionProfileStore({ filePath });

    await expect(store.reset()).rejects.toThrow();
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-permission-profile-"));
  temporaryDirectories.push(directory);
  return directory;
}

function profileWithTtl(ttlDays: number) {
  const document = createDefaultPermissionProfileDocument();
  const profile = document.profiles.default;
  if (profile === undefined) {
    throw new Error("Expected default permission profile.");
  }
  return {
    ...document,
    profiles: {
      ...document.profiles,
      default: {
        ...profile,
        authorization: { ttlDays },
      },
    },
  };
}

async function writeDocument(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
