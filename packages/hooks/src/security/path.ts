import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { HookSecurityError } from "../errors.js";

export interface HookPathInspection {
  readonly device: number;
  readonly inode: number;
  readonly isSymbolicLink: boolean;
  readonly mode: number;
  readonly ownerId: number;
  readonly path: string;
  readonly realPath: string;
  readonly size: number;
}

export interface HookPathPolicy {
  readonly allowGroupWritable?: boolean | undefined;
  readonly allowSymbolicLink?: boolean | undefined;
  readonly allowedOwnerIds?: readonly number[] | undefined;
}

export async function inspectHookPath(path: string): Promise<HookPathInspection> {
  if (!isAbsolute(path)) {
    throw securityError("Hook path must be absolute.");
  }

  try {
    const link = await lstat(path);
    const resolved = await realpath(path);
    const target = await stat(resolved);

    if (!target.isFile()) {
      throw securityError("Hook path must resolve to a regular file.");
    }

    return Object.freeze({
      device: target.dev,
      inode: target.ino,
      isSymbolicLink: link.isSymbolicLink(),
      mode: target.mode & 0o777,
      ownerId: target.uid,
      path,
      realPath: resolved,
      size: target.size,
    });
  } catch (error) {
    if (error instanceof HookSecurityError) {
      throw error;
    }

    throw new HookSecurityError("HOOK_SECURITY_REJECTED", "Unable to inspect Hook path.", {
      cause: error,
    });
  }
}

export async function requireSafeHookPath(
  path: string,
  policy: HookPathPolicy = {},
): Promise<HookPathInspection> {
  const inspection = await inspectHookPath(path);
  const ownerIds = policy.allowedOwnerIds ?? defaultOwnerIds();

  if (inspection.isSymbolicLink && policy.allowSymbolicLink !== true) {
    throw securityError("Hook path must not be a symbolic link.");
  }

  if ((inspection.mode & 0o002) !== 0) {
    throw securityError("Hook path must not be world-writable.");
  }

  if ((inspection.mode & 0o020) !== 0 && policy.allowGroupWritable !== true) {
    throw securityError("Hook path must not be group-writable.");
  }

  if (ownerIds.length > 0 && !ownerIds.includes(inspection.ownerId)) {
    throw securityError("Hook path owner is not trusted.");
  }

  return inspection;
}

function defaultOwnerIds(): readonly number[] {
  const currentOwner = typeof process.getuid === "function" ? process.getuid() : undefined;

  return currentOwner === undefined ? [] : [...new Set([0, currentOwner])];
}

function securityError(message: string): HookSecurityError {
  return new HookSecurityError("HOOK_SECURITY_REJECTED", message);
}
