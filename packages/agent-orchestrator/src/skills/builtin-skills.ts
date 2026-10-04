import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveBuiltinSkillsDirectory(moduleUrl: string | URL = import.meta.url): string {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const packageSection = basename(dirname(moduleDirectory));

  return packageSection === "dist"
    ? resolve(moduleDirectory, "../../src/skills/builtin")
    : resolve(moduleDirectory, "builtin");
}
