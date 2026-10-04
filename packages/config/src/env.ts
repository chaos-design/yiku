import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";

export type EnvVars = Record<string, string | undefined>;

export interface LoadEnvFileOptions {
  readonly cwd?: string;
  readonly filePath?: string;
  readonly fileName?: string;
}

export function loadEnvFile(options: LoadEnvFileOptions = {}): EnvVars {
  const cwd = options.cwd ?? process.cwd();
  const fileName = options.fileName ?? ".env";
  const envPath = options.filePath ?? join(cwd, fileName);

  if (!existsSync(envPath)) {
    return {};
  }

  return parse(readFileSync(envPath));
}
