import { promises as fs } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type { AgentWorkspaceScope } from "../session/agent-profile.js";

const PACKAGE_ROOTS = ["packages", "apps", "services"] as const;
const SOURCE_ROOTS = ["src", "app", "server", "client"] as const;
const MAX_SCOPES = 4;

export async function discoverAgentWorkspaceScopes(
  workspaceDir: string,
): Promise<readonly AgentWorkspaceScope[]> {
  const root = await fs.realpath(resolve(workspaceDir));
  const packageScopes = await discoverPackageScopes(root);
  const scopes: AgentWorkspaceScope[] = packageScopes.slice(0, 2);

  if (await isDirectory(join(root, "docs"))) {
    scopes.push({
      description: "架构、API 与项目文档",
      label: "文档 docs/",
      path: "docs",
    });
  }

  if (scopes.length < MAX_SCOPES - 1) {
    const sourceScopes = await discoverSourceScopes(root);
    for (const scope of sourceScopes) {
      if (scopes.length >= MAX_SCOPES - 1) {
        break;
      }
      if (!scopes.some((candidate) => candidate.path === scope.path)) {
        scopes.push(scope);
      }
    }
  }

  scopes.push({
    description: "覆盖当前 workspace 的全部代码与文档",
    label: "整个工作区",
    path: ".",
  });

  return Object.freeze(scopes.slice(0, MAX_SCOPES).map((scope) => Object.freeze(scope)));
}

async function discoverPackageScopes(root: string): Promise<AgentWorkspaceScope[]> {
  const packages: AgentWorkspaceScope[] = [];
  for (const packageRoot of PACKAGE_ROOTS) {
    const directory = join(root, packageRoot);
    for (const packagePath of await packageDirectories(directory, 2)) {
      const manifest = await readPackageManifest(join(packagePath, "package.json"));
      if (manifest === undefined) {
        continue;
      }
      const path = normalizeRelative(root, packagePath);
      const name = packageDisplayName(manifest.name, basename(packagePath));
      packages.push({
        description: manifest.description ?? `${path} package`,
        label: isFrontendPackage(manifest) ? `前端 ${name}` : name,
        path,
      });
    }
  }
  return packages.toSorted(
    (left, right) =>
      scopePriority(left) - scopePriority(right) || left.path.localeCompare(right.path, "en"),
  );
}

async function discoverSourceScopes(root: string): Promise<AgentWorkspaceScope[]> {
  const scopes: AgentWorkspaceScope[] = [];
  for (const name of SOURCE_ROOTS) {
    if (await isDirectory(join(root, name))) {
      scopes.push({
        description: `${name}/ source tree`,
        label: name,
        path: name,
      });
    }
  }
  return scopes;
}

async function packageDirectories(root: string, depth: number): Promise<string[]> {
  if (depth < 0) {
    return [];
  }
  let entries: Array<{
    readonly name: string;
    isDirectory(): boolean;
  }>;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const directories: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    const path = join(root, entry.name);
    if (await isFile(join(path, "package.json"))) {
      directories.push(path);
      continue;
    }
    directories.push(...(await packageDirectories(path, depth - 1)));
  }
  return directories;
}

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>> | undefined;
  readonly description?: string | undefined;
  readonly devDependencies?: Readonly<Record<string, string>> | undefined;
  readonly name?: string | undefined;
  readonly scripts?: Readonly<Record<string, string>> | undefined;
}

async function readPackageManifest(path: string): Promise<PackageManifest | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(path, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    return {
      ...(isStringRecord(record.dependencies) ? { dependencies: record.dependencies } : {}),
      ...(typeof record.description === "string" && record.description.trim()
        ? { description: record.description.trim() }
        : {}),
      ...(isStringRecord(record.devDependencies)
        ? { devDependencies: record.devDependencies }
        : {}),
      ...(typeof record.name === "string" && record.name.trim()
        ? { name: record.name.trim() }
        : {}),
      ...(isStringRecord(record.scripts) ? { scripts: record.scripts } : {}),
    };
  } catch {
    return undefined;
  }
}

function isFrontendPackage(manifest: PackageManifest): boolean {
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };
  return (
    "react" in dependencies ||
    "vite" in dependencies ||
    Object.keys(manifest.scripts ?? {}).some((script) => script.includes("web"))
  );
}

function packageDisplayName(name: string | undefined, fallback: string): string {
  return name?.replace(/^@[^/]+\//u, "") || fallback;
}

function scopePriority(scope: AgentWorkspaceScope): number {
  return scope.label.startsWith("前端 ") ? 0 : 1;
}

function normalizeRelative(root: string, path: string): string {
  const value = relative(root, path);
  if (!value || value === ".." || value.startsWith(`..${sep}`)) {
    throw new Error("Discovered Agent scope must stay inside the workspace.");
  }
  return value.split(sep).join("/");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile();
  } catch {
    return false;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}
