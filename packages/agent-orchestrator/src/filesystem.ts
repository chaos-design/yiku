import { open } from "node:fs/promises";

export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export function isAlreadyExistsError(error: unknown): boolean {
  return isErrorCode(error, "EEXIST");
}

export function isNotFoundError(error: unknown): boolean {
  return isErrorCode(error, "ENOENT");
}

export function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
