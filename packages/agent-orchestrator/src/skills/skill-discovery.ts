import type { Dirent } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { isNotFoundError } from "../filesystem.js";
import { resolveBuiltinSkillsDirectory } from "./builtin-skills.js";
import { parseSkillMarkdown } from "./skill-parser.js";
import type {
  SkillDescriptor,
  SkillDiagnostic,
  SkillDiscoveryResult,
  SkillSource,
} from "./skill-types.js";

export interface DiscoverSkillsOptions {
  readonly builtinDir?: string | undefined;
  readonly builtinShadowedBy?: readonly string[] | undefined;
  readonly homeDir: string;
  readonly workspaceDir: string;
}

interface SourceDiscovery {
  readonly diagnostics: readonly SkillDiagnostic[];
  readonly skills: readonly SkillDescriptor[];
}

export async function discoverSkills(
  options: DiscoverSkillsOptions,
): Promise<SkillDiscoveryResult> {
  const [builtin, user, project] = await Promise.all([
    discoverSource(options.builtinDir ?? resolveBuiltinSkillsDirectory(), "builtin", true),
    discoverSource(join(options.homeDir, ".yiku", "skills"), "user"),
    discoverSource(join(options.workspaceDir, ".yiku", "skills"), "project"),
  ]);
  const merged = mergeSources(
    [builtin, user, project],
    new Set(options.builtinShadowedBy?.map((name) => name.trim()).filter(Boolean) ?? []),
  );

  return Object.freeze({
    diagnostics: Object.freeze(merged.diagnostics),
    shadowed: Object.freeze(merged.shadowed),
    skills: Object.freeze(merged.skills),
  });
}

async function discoverSource(
  skillsDir: string,
  source: SkillSource,
  required = false,
): Promise<SourceDiscovery> {
  let canonicalRoot: string;
  let entries: Dirent<string>[];

  try {
    canonicalRoot = await realpath(skillsDir);
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      return required
        ? {
            diagnostics: [
              diagnostic("SKILL_DISCOVERY_FAILED", skillsDir, "Skill directory does not exist."),
            ],
            skills: [],
          }
        : emptySourceDiscovery();
    }
    return {
      diagnostics: [
        diagnostic(
          "SKILL_DISCOVERY_FAILED",
          skillsDir,
          error instanceof Error ? error.message : String(error),
        ),
      ],
      skills: [],
    };
  }

  const parsed: SkillDescriptor[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const configuredPath = join(skillsDir, entry.name, "SKILL.md");
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(configuredPath);
    } catch (error) {
      if (!isNotFoundError(error)) {
        diagnostics.push(
          diagnostic(
            "SKILL_DISCOVERY_FAILED",
            configuredPath,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
      continue;
    }

    if (!isWithin(canonicalRoot, canonicalPath)) {
      diagnostics.push(
        diagnostic(
          "SKILL_PATH_ESCAPE",
          configuredPath,
          "Skill path resolves outside its configured Skill directory.",
        ),
      );
      continue;
    }

    try {
      const result = parseSkillMarkdown(
        await readFile(canonicalPath, "utf8"),
        canonicalPath,
        source,
      );
      if (result.ok) {
        if (result.descriptor.name !== entry.name) {
          diagnostics.push(
            diagnostic(
              "SKILL_INVALID_FRONTMATTER",
              canonicalPath,
              `Skill name must match its parent directory: ${entry.name}.`,
            ),
          );
          continue;
        }
        parsed.push(result.descriptor);
      } else {
        diagnostics.push(result.diagnostic);
      }
    } catch (error) {
      diagnostics.push(
        diagnostic(
          "SKILL_DISCOVERY_FAILED",
          canonicalPath,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  const byName = new Map<string, SkillDescriptor[]>();
  for (const skill of parsed) {
    const values = byName.get(skill.name) ?? [];
    values.push(skill);
    byName.set(skill.name, values);
  }
  const duplicates = new Set(
    [...byName.entries()].filter(([, values]) => values.length > 1).map(([name]) => name),
  );
  for (const name of duplicates) {
    for (const skill of byName.get(name) ?? []) {
      diagnostics.push(
        diagnostic(
          "SKILL_DUPLICATE_NAME",
          skill.path,
          `Skill name is duplicated in the ${source} source: ${name}.`,
        ),
      );
    }
  }

  return {
    diagnostics: diagnostics.toSorted(compareDiagnostics),
    skills: parsed.filter((skill) => !duplicates.has(skill.name)).toSorted(compareSkills),
  };
}

function mergeSources(
  sources: readonly SourceDiscovery[],
  builtinShadowedBy: ReadonlySet<string>,
): {
  readonly diagnostics: readonly SkillDiagnostic[];
  readonly shadowed: readonly SkillDescriptor[];
  readonly skills: readonly SkillDescriptor[];
} {
  const diagnostics = sources.flatMap((source) => [...source.diagnostics]);
  const byName = new Map<string, SkillDescriptor[]>();
  for (const skill of sources.flatMap((source) => [...source.skills])) {
    const values = byName.get(skill.name) ?? [];
    values.push(skill);
    byName.set(skill.name, values);
  }

  const skills: SkillDescriptor[] = [];
  const shadowed: SkillDescriptor[] = [];
  for (const [name, candidates] of byName) {
    const ranked = candidates.toSorted(
      (left, right) =>
        sourcePriority(right.source) - sourcePriority(left.source) ||
        left.path.localeCompare(right.path),
    );
    const winner = ranked[0];
    if (winner === undefined) {
      continue;
    }
    if (winner.source === "builtin" && builtinShadowedBy.has(name)) {
      shadowed.push(winner);
      diagnostics.push(shadowedDiagnostic(winner, "configured"));
      continue;
    }

    skills.push(winner);
    for (const candidate of ranked.slice(1)) {
      shadowed.push(candidate);
      diagnostics.push(shadowedDiagnostic(candidate, winner.source));
    }
  }

  return {
    diagnostics: diagnostics.toSorted(compareDiagnostics),
    shadowed: shadowed.toSorted(compareSkills),
    skills: skills.toSorted(compareSkills),
  };
}

function diagnostic(code: string, path: string, message: string): SkillDiagnostic {
  return Object.freeze({
    code,
    message,
    path,
    severity: "error",
  });
}

function shadowedDiagnostic(
  skill: SkillDescriptor,
  winner: SkillSource | "configured",
): SkillDiagnostic {
  return Object.freeze({
    code: "SKILL_SHADOWED",
    message: `${sourceLabel(skill.source)} Skill ${skill.name} is shadowed by the ${winner} Skill.`,
    path: skill.path,
    severity: "info",
  });
}

function emptySourceDiscovery(): SourceDiscovery {
  return {
    diagnostics: [],
    skills: [],
  };
}

function isWithin(root: string, path: string): boolean {
  const boundary = relative(root, path);
  return boundary !== ".." && !boundary.startsWith("../") && !boundary.startsWith("..\\");
}

function compareSkills(left: SkillDescriptor, right: SkillDescriptor): number {
  return left.name.localeCompare(right.name) || left.path.localeCompare(right.path);
}

function compareDiagnostics(left: SkillDiagnostic, right: SkillDiagnostic): number {
  return left.path.localeCompare(right.path) || left.code.localeCompare(right.code);
}

function sourcePriority(source: SkillSource): number {
  switch (source) {
    case "builtin":
      return 0;
    case "user":
      return 1;
    case "project":
      return 2;
  }
}

function sourceLabel(source: SkillSource): string {
  switch (source) {
    case "builtin":
      return "Built-in";
    case "user":
      return "User";
    case "project":
      return "Project";
  }
}
