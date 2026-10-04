export const PERMISSION_RULE_DECISIONS = ["allow", "ask", "deny"] as const;
export const WORKSPACE_ACCESS_MODES = ["read-only", "read-write"] as const;

export type PermissionRuleDecision = (typeof PERMISSION_RULE_DECISIONS)[number];
export type WorkspaceAccessMode = (typeof WORKSPACE_ACCESS_MODES)[number];

export interface WorkspaceAuthorizationRecord {
  readonly expiresAt: string;
  readonly grantedAt: string;
  readonly path: string;
  readonly rootRealPath: string;
}

export interface PermissionApprovalConfig {
  readonly commandRules: Readonly<Record<string, PermissionRuleDecision>>;
  readonly mcpRules: Readonly<Record<string, PermissionRuleDecision>>;
  readonly policyRules: Readonly<Record<string, PermissionRuleDecision>>;
  readonly reviewer: "user";
}

export interface PermissionProfile {
  readonly approval: PermissionApprovalConfig;
  readonly authorization: {
    readonly ttlDays: number;
  };
  readonly displayName: string;
  readonly filesystem: {
    readonly default: "read_only" | "read_write";
  };
  readonly network: {
    readonly default: PermissionRuleDecision;
  };
  readonly shellSandbox: {
    readonly enable: boolean;
    readonly onRestrict: "deny" | "request_permission_retry_sandbox";
  };
}

export interface PermissionProfileDocument {
  readonly _migrationVersion: 2;
  readonly activeProfile: string;
  readonly profiles: Readonly<Record<string, PermissionProfile>>;
  readonly resourceAuthorization: {
    readonly filesystem: {
      readonly readOnly: readonly WorkspaceAuthorizationRecord[];
      readonly readWrite: readonly WorkspaceAuthorizationRecord[];
    };
    readonly network: {
      readonly allow: readonly string[];
      readonly deny: readonly string[];
    };
  };
}

export class PermissionProfileValidationError extends Error {
  public override readonly name = "PermissionProfileValidationError";
}

export function createDefaultPermissionProfileDocument(): PermissionProfileDocument {
  return {
    _migrationVersion: 2,
    activeProfile: "default",
    profiles: {
      default: {
        approval: {
          commandRules: {},
          mcpRules: {},
          policyRules: {
            "known-low-risk-command": "allow",
            "workspace-file-write": "allow",
          },
          reviewer: "user",
        },
        authorization: {
          ttlDays: 7,
        },
        displayName: "Default",
        filesystem: {
          default: "read_only",
        },
        network: {
          default: "allow",
        },
        shellSandbox: {
          enable: true,
          onRestrict: "request_permission_retry_sandbox",
        },
      },
    },
    resourceAuthorization: {
      filesystem: {
        readOnly: [],
        readWrite: [],
      },
      network: {
        allow: [],
        deny: [],
      },
    },
  };
}

export function parsePermissionProfileDocument(value: unknown): PermissionProfileDocument {
  const document = requireRecord(value, "Permission document");
  const activeProfile = requireString(document.activeProfile, "activeProfile");
  const rawProfiles = requireRecord(document.profiles, "profiles");
  const parsedProfiles = Object.fromEntries(
    Object.entries(rawProfiles).map(([name, profile]) => [
      requireString(name, "profile name"),
      parseProfile(profile, `profiles.${name}`),
    ]),
  );
  const migrationVersion = document._migrationVersion;
  if (migrationVersion !== 1 && migrationVersion !== 2) {
    throw new PermissionProfileValidationError("_migrationVersion must be 1 or 2.");
  }
  const profiles = migrateProfiles(parsedProfiles, migrationVersion);
  if (profiles[activeProfile] === undefined) {
    throw new PermissionProfileValidationError(
      `Active permission profile does not exist: ${activeProfile}.`,
    );
  }

  const resourceAuthorization = requireRecord(
    document.resourceAuthorization,
    "resourceAuthorization",
  );
  const filesystem = requireRecord(
    resourceAuthorization.filesystem,
    "resourceAuthorization.filesystem",
  );
  const network = requireRecord(resourceAuthorization.network, "resourceAuthorization.network");
  return {
    _migrationVersion: 2,
    activeProfile,
    profiles,
    resourceAuthorization: {
      filesystem: {
        readOnly: parseWorkspaceAuthorizations(
          filesystem.readOnly,
          "resourceAuthorization.filesystem.readOnly",
        ),
        readWrite: parseWorkspaceAuthorizations(
          filesystem.readWrite,
          "resourceAuthorization.filesystem.readWrite",
        ),
      },
      network: {
        allow: parseStringArray(network.allow, "resourceAuthorization.network.allow"),
        deny: parseStringArray(network.deny, "resourceAuthorization.network.deny"),
      },
    },
  };
}

function migrateProfiles(
  profiles: Readonly<Record<string, PermissionProfile>>,
  migrationVersion: 1 | 2,
): Readonly<Record<string, PermissionProfile>> {
  const defaultProfile = profiles.default;
  if (migrationVersion !== 1 || defaultProfile === undefined) {
    return profiles;
  }
  return {
    ...profiles,
    default: {
      ...defaultProfile,
      network: {
        default: "allow",
      },
    },
  };
}

function parseProfile(value: unknown, path: string): PermissionProfile {
  const profile = requireRecord(value, path);
  const approval = requireRecord(profile.approval, `${path}.approval`);
  const authorization = requireRecord(profile.authorization, `${path}.authorization`);
  const filesystem = requireRecord(profile.filesystem, `${path}.filesystem`);
  const network = requireRecord(profile.network, `${path}.network`);
  const shellSandbox = requireRecord(profile.shellSandbox, `${path}.shellSandbox`);
  const ttlDays = authorization.ttlDays;
  if (!Number.isSafeInteger(ttlDays) || (ttlDays as number) <= 0) {
    throw new PermissionProfileValidationError(`${path}.authorization.ttlDays must be positive.`);
  }
  const filesystemDefault = filesystem.default;
  if (filesystemDefault !== "read_only" && filesystemDefault !== "read_write") {
    throw new PermissionProfileValidationError(
      `${path}.filesystem.default must be read_only or read_write.`,
    );
  }
  const onRestrict = shellSandbox.onRestrict;
  if (onRestrict !== "deny" && onRestrict !== "request_permission_retry_sandbox") {
    throw new PermissionProfileValidationError(`${path}.shellSandbox.onRestrict is invalid.`);
  }
  if (approval.reviewer !== "user") {
    throw new PermissionProfileValidationError(`${path}.approval.reviewer must be user.`);
  }

  return {
    approval: {
      commandRules: parseRuleRecord(approval.commandRules, `${path}.approval.commandRules`),
      mcpRules: parseRuleRecord(approval.mcpRules, `${path}.approval.mcpRules`),
      policyRules: parseRuleRecord(approval.policyRules, `${path}.approval.policyRules`),
      reviewer: "user",
    },
    authorization: {
      ttlDays: ttlDays as number,
    },
    displayName: requireString(profile.displayName, `${path}.displayName`),
    filesystem: {
      default: filesystemDefault,
    },
    network: {
      default: parseDecision(network.default, `${path}.network.default`),
    },
    shellSandbox: {
      enable: requireBoolean(shellSandbox.enable, `${path}.shellSandbox.enable`),
      onRestrict,
    },
  };
}

function parseRuleRecord(
  value: unknown,
  path: string,
): Readonly<Record<string, PermissionRuleDecision>> {
  const record = requireRecord(value, path);
  return Object.fromEntries(
    Object.entries(record).map(([key, decision]) => [
      requireString(key, `${path} key`),
      parseDecision(decision, `${path}.${key}`),
    ]),
  );
}

function parseWorkspaceAuthorizations(
  value: unknown,
  path: string,
): readonly WorkspaceAuthorizationRecord[] {
  if (!Array.isArray(value)) {
    throw new PermissionProfileValidationError(`${path} must be an array.`);
  }
  return value.map((item, index) => {
    const record = requireRecord(item, `${path}.${index}`);
    const authorization = {
      expiresAt: requireDate(record.expiresAt, `${path}.${index}.expiresAt`),
      grantedAt: requireDate(record.grantedAt, `${path}.${index}.grantedAt`),
      path: requireString(record.path, `${path}.${index}.path`),
      rootRealPath: requireString(record.rootRealPath, `${path}.${index}.rootRealPath`),
    };
    return authorization;
  });
}

function parseStringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new PermissionProfileValidationError(`${path} must be an array.`);
  }
  return value.map((item, index) => requireString(item, `${path}.${index}`));
}

function parseDecision(value: unknown, path: string): PermissionRuleDecision {
  if (
    typeof value !== "string" ||
    !PERMISSION_RULE_DECISIONS.includes(value as PermissionRuleDecision)
  ) {
    throw new PermissionProfileValidationError(`${path} must be allow, ask, or deny.`);
  }
  return value as PermissionRuleDecision;
}

function requireDate(value: unknown, path: string): string {
  const text = requireString(value, path);
  if (!Number.isFinite(Date.parse(text))) {
    throw new PermissionProfileValidationError(`${path} must be an ISO date.`);
  }
  return text;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PermissionProfileValidationError(`${path} must be a non-empty string.`);
  }
  return value.trim();
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new PermissionProfileValidationError(`${path} must be a boolean.`);
  }
  return value;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PermissionProfileValidationError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}
