import { describe, expect, it } from "vitest";
import {
  createDefaultPermissionProfileDocument,
  PermissionProfileValidationError,
  parsePermissionProfileDocument,
} from "../../src/permission/profile-schema.js";

describe("parsePermissionProfileDocument", () => {
  it("allows network access in the default profile", () => {
    const document = createDefaultPermissionProfileDocument();

    expect(document._migrationVersion).toBe(2);
    expect(document.profiles.default?.network.default).toBe("allow");
  });

  it("migrates the legacy default network policy without changing custom profiles", () => {
    const document = createDefaultPermissionProfileDocument();
    const defaultProfile = document.profiles.default;
    if (defaultProfile === undefined) {
      throw new Error("Expected default permission profile.");
    }
    const parsed = parsePermissionProfileDocument({
      ...document,
      _migrationVersion: 1,
      profiles: {
        custom: {
          ...defaultProfile,
          network: { default: "deny" },
        },
        default: {
          ...defaultProfile,
          network: { default: "deny" },
        },
      },
    });

    expect(parsed).toMatchObject({
      _migrationVersion: 2,
      profiles: {
        custom: { network: { default: "deny" } },
        default: { network: { default: "allow" } },
      },
    });
  });

  it("parses alternate profiles, rules, and resource authorizations", () => {
    const document = createDefaultPermissionProfileDocument();
    const base = document.profiles.default;
    if (base === undefined) {
      throw new Error("Expected default permission profile.");
    }

    expect(
      parsePermissionProfileDocument({
        ...document,
        activeProfile: "strict",
        profiles: {
          strict: {
            ...base,
            approval: {
              commandRules: { "git *": "ask" },
              mcpRules: { "github/delete_*": "deny" },
              policyRules: { "workspace-edit": "allow" },
              reviewer: "user",
            },
            filesystem: { default: "read_write" },
            network: { default: "allow" },
            shellSandbox: {
              enable: false,
              onRestrict: "deny",
            },
          },
        },
        resourceAuthorization: {
          filesystem: {
            readOnly: [
              {
                expiresAt: "2026-08-10T00:00:00.000Z",
                grantedAt: "2026-08-09T00:00:00.000Z",
                path: "/workspace",
                rootRealPath: "/workspace",
              },
            ],
            readWrite: [],
          },
          network: {
            allow: ["example.com"],
            deny: ["blocked.example"],
          },
        },
      }),
    ).toMatchObject({
      activeProfile: "strict",
      profiles: {
        strict: {
          filesystem: { default: "read_write" },
          network: { default: "allow" },
          shellSandbox: { enable: false, onRestrict: "deny" },
        },
      },
    });
  });

  it("rejects non-object document roots", () => {
    expect(() => parsePermissionProfileDocument(null)).toThrow(PermissionProfileValidationError);
    expect(() => parsePermissionProfileDocument([])).toThrow(PermissionProfileValidationError);
  });

  it.each([
    ["active profile", (value: unknown) => value, { activeProfile: "" }],
    ["active profile type", (value: unknown) => value, { activeProfile: 1 }],
    ["missing active profile", (value: unknown) => value, { activeProfile: "missing" }],
    ["migration version", (value: unknown) => value, { _migrationVersion: 3 }],
    ["profiles object", (value: unknown) => value, { profiles: [] }],
    [
      "TTL type",
      (value: unknown) => nested(value, "profiles", "default", "authorization"),
      { ttlDays: "7" },
    ],
    [
      "TTL range",
      (value: unknown) => nested(value, "profiles", "default", "authorization"),
      { ttlDays: 0 },
    ],
    [
      "filesystem default",
      (value: unknown) => nested(value, "profiles", "default", "filesystem"),
      { default: "write_everywhere" },
    ],
    [
      "sandbox action",
      (value: unknown) => nested(value, "profiles", "default", "shellSandbox"),
      { enable: true, onRestrict: "ignore" },
    ],
    [
      "sandbox enable",
      (value: unknown) => nested(value, "profiles", "default", "shellSandbox"),
      { enable: "yes", onRestrict: "deny" },
    ],
    [
      "reviewer",
      (value: unknown) => nested(value, "profiles", "default", "approval"),
      {
        commandRules: {},
        mcpRules: {},
        policyRules: {},
        reviewer: "system",
      },
    ],
    [
      "rule decision",
      (value: unknown) => nested(value, "profiles", "default", "approval"),
      {
        commandRules: { rm: "skip" },
        mcpRules: {},
        policyRules: {},
        reviewer: "user",
      },
    ],
    [
      "authorization array",
      (value: unknown) => nested(value, "resourceAuthorization", "filesystem"),
      { readOnly: {}, readWrite: [] },
    ],
    [
      "network array",
      (value: unknown) => nested(value, "resourceAuthorization", "network"),
      { allow: "all", deny: [] },
    ],
    [
      "authorization date",
      (value: unknown) => nested(value, "resourceAuthorization", "filesystem"),
      {
        readOnly: [
          {
            expiresAt: "never",
            grantedAt: "2026-08-09T00:00:00.000Z",
            path: "/workspace",
            rootRealPath: "/workspace",
          },
        ],
        readWrite: [],
      },
    ],
  ])("rejects invalid %s", (_label, select, replacement) => {
    const value = structuredClone(createDefaultPermissionProfileDocument()) as unknown;
    const target = select(value);
    if (target === value) {
      Object.assign(target as object, replacement as object);
    } else {
      replaceObject(target, replacement);
    }

    expect(() => parsePermissionProfileDocument(value)).toThrow(PermissionProfileValidationError);
  });
});

function nested(value: unknown, ...keys: string[]): Record<string, unknown> {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      throw new Error(`Expected object at ${key}.`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    throw new Error("Expected nested object.");
  }
  return current as Record<string, unknown>;
}

function replaceObject(target: Record<string, unknown>, replacement: unknown): void {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, replacement as object);
}
