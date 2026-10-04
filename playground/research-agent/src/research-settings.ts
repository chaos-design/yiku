import type { ResearchSearchContextSize, ResearchSkillId, ResearchTurnOptions } from "./types.js";

export type ResearchResponseStyle = "balanced" | "concise" | "detailed";
export type ResearchSendMode = "enter" | "mod-enter";
export type ResearchSearchContextPreference = "server-default" | ResearchSearchContextSize;

export interface ResearchCustomSkill {
  readonly baseSkill: ResearchSkillId;
  readonly description: string;
  readonly enabled: boolean;
  readonly id: string;
  readonly instructions: string;
  readonly name: string;
}

export interface ResearchSettings {
  readonly builtinSkills: Readonly<Record<ResearchSkillId, boolean>>;
  readonly customInstructions: string;
  readonly customSkills: readonly ResearchCustomSkill[];
  readonly defaultSkillId: string;
  readonly requirePrimarySources: boolean;
  readonly responseStyle: ResearchResponseStyle;
  readonly searchContext: ResearchSearchContextPreference;
  readonly sendMode: ResearchSendMode;
}

export interface ResearchSkillPreset {
  readonly baseSkill: ResearchSkillId;
  readonly description: string;
  readonly id: string;
  readonly instructions?: string | undefined;
  readonly label: string;
  readonly source: "builtin" | "custom";
}

const STORAGE_KEY = "yiku.research.settings.v1";
const MAX_CUSTOM_SKILLS = 12;
const MAX_CUSTOM_INSTRUCTIONS = 2_000;

const DEFAULT_RESEARCH_SKILL: ResearchSkillPreset = {
  baseSkill: "research",
  description: "平衡检索深度、证据记录与引用校验。",
  id: "research",
  label: "Research",
  source: "builtin",
};

export const BUILTIN_RESEARCH_SKILLS: readonly ResearchSkillPreset[] = [
  DEFAULT_RESEARCH_SKILL,
  {
    baseSkill: "quick-research",
    description: "收紧检索范围，优先一个权威来源并快速返回。",
    id: "quick-research",
    label: "Quick research",
    source: "builtin",
  },
  {
    baseSkill: "deep-research",
    description: "扩大检索范围，交叉验证复杂或有争议的主题。",
    id: "deep-research",
    label: "Deep research",
    source: "builtin",
  },
];

export function defaultResearchSettings(): ResearchSettings {
  return {
    builtinSkills: {
      "deep-research": true,
      "quick-research": true,
      research: true,
    },
    customInstructions: "",
    customSkills: [],
    defaultSkillId: "research",
    requirePrimarySources: true,
    responseStyle: "balanced",
    searchContext: "server-default",
    sendMode: "enter",
  };
}

export function loadResearchSettings(): ResearchSettings {
  if (typeof window === "undefined") {
    return defaultResearchSettings();
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeResearchSettings(JSON.parse(raw) as unknown) : defaultResearchSettings();
  } catch {
    return defaultResearchSettings();
  }
}

export function saveResearchSettings(settings: ResearchSettings): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeResearchSettings(settings)));
  } catch {
    // Browser storage can be unavailable in private or locked-down contexts.
  }
}

export function availableSkillPresets(settings: ResearchSettings): readonly ResearchSkillPreset[] {
  const builtin = BUILTIN_RESEARCH_SKILLS.filter(
    ({ baseSkill }) => settings.builtinSkills[baseSkill],
  );
  const custom = settings.customSkills
    .filter((skill) => skill.enabled)
    .map(
      (skill): ResearchSkillPreset => ({
        baseSkill: skill.baseSkill,
        description: skill.description,
        id: skill.id,
        instructions: skill.instructions,
        label: skill.name,
        source: "custom",
      }),
    );
  return [...builtin, ...custom];
}

export function selectedSkillPreset(settings: ResearchSettings): ResearchSkillPreset {
  const available = availableSkillPresets(settings);
  return (
    available.find((skill) => skill.id === settings.defaultSkillId) ??
    available[0] ??
    DEFAULT_RESEARCH_SKILL
  );
}

export function buildResearchTurnOptions(
  settings: ResearchSettings,
  skill: ResearchSkillPreset,
): ResearchTurnOptions {
  const instructions = [
    responseStyleInstruction(settings.responseStyle),
    settings.requirePrimarySources
      ? "Prefer authoritative primary sources. Use secondary sources only when they add necessary context or independent corroboration."
      : undefined,
    skill.instructions?.trim() || undefined,
    settings.customInstructions.trim() || undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join("\n\n");

  return {
    ...(instructions ? { instructions } : {}),
    ...(settings.searchContext === "server-default"
      ? {}
      : { searchContextSize: settings.searchContext }),
  };
}

export function createCustomSkill(input: {
  readonly baseSkill: ResearchSkillId;
  readonly description: string;
  readonly instructions: string;
  readonly name: string;
}): ResearchCustomSkill {
  return {
    baseSkill: input.baseSkill,
    description: input.description.trim().slice(0, 120),
    enabled: true,
    id: `custom:${createId()}`,
    instructions: input.instructions.trim().slice(0, MAX_CUSTOM_INSTRUCTIONS),
    name: input.name.trim().slice(0, 40),
  };
}

function normalizeResearchSettings(value: unknown): ResearchSettings {
  const defaults = defaultResearchSettings();
  if (!isRecord(value)) {
    return defaults;
  }

  const builtinValue = isRecord(value.builtinSkills) ? value.builtinSkills : {};
  const customSkills = Array.isArray(value.customSkills)
    ? value.customSkills
        .map(normalizeCustomSkill)
        .filter((skill): skill is ResearchCustomSkill => skill !== undefined)
        .slice(0, MAX_CUSTOM_SKILLS)
    : [];
  const builtinSkills: Record<ResearchSkillId, boolean> = {
    "deep-research": boolean(builtinValue["deep-research"], true),
    "quick-research": boolean(builtinValue["quick-research"], true),
    research: boolean(builtinValue.research, true),
  };
  if (!Object.values(builtinSkills).some(Boolean) && !customSkills.some((skill) => skill.enabled)) {
    builtinSkills.research = true;
  }

  const normalized: ResearchSettings = {
    builtinSkills,
    customInstructions: text(value.customInstructions)?.slice(0, MAX_CUSTOM_INSTRUCTIONS) ?? "",
    customSkills,
    defaultSkillId: text(value.defaultSkillId) ?? defaults.defaultSkillId,
    requirePrimarySources: boolean(value.requirePrimarySources, defaults.requirePrimarySources),
    responseStyle: responseStyle(value.responseStyle),
    searchContext: searchContext(value.searchContext),
    sendMode: sendMode(value.sendMode),
  };
  const selected = selectedSkillPreset(normalized);
  return selected.id === normalized.defaultSkillId
    ? normalized
    : { ...normalized, defaultSkillId: selected.id };
}

function normalizeCustomSkill(value: unknown): ResearchCustomSkill | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = text(value.id);
  const name = text(value.name);
  const instructions = text(value.instructions);
  if (!id?.startsWith("custom:") || !name || !instructions) {
    return undefined;
  }
  return {
    baseSkill: researchSkillId(value.baseSkill),
    description: text(value.description)?.slice(0, 120) ?? "",
    enabled: boolean(value.enabled, true),
    id: id.slice(0, 128),
    instructions: instructions.slice(0, MAX_CUSTOM_INSTRUCTIONS),
    name: name.slice(0, 40),
  };
}

function responseStyleInstruction(style: ResearchResponseStyle): string {
  switch (style) {
    case "concise":
      return "Keep the final report concise. Lead with the answer, retain essential evidence, and omit background that does not change the conclusion.";
    case "detailed":
      return "Produce a detailed research report with explicit reasoning, material caveats, source comparisons, and a clear conclusion.";
    case "balanced":
      return "Produce a balanced research report: answer directly, show the strongest evidence, and preserve material uncertainty without unnecessary detail.";
  }
}

function researchSkillId(value: unknown): ResearchSkillId {
  return value === "quick-research" || value === "deep-research" || value === "research"
    ? value
    : "research";
}

function responseStyle(value: unknown): ResearchResponseStyle {
  return value === "concise" || value === "detailed" || value === "balanced" ? value : "balanced";
}

function searchContext(value: unknown): ResearchSearchContextPreference {
  return value === "low" || value === "medium" || value === "high" || value === "server-default"
    ? value
    : "server-default";
}

function sendMode(value: unknown): ResearchSendMode {
  return value === "mod-enter" || value === "enter" ? value : "enter";
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
