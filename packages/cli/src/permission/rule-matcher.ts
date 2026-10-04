import type {
  PermissionProfile,
  PermissionProfileDocument,
  PermissionRuleDecision,
} from "./profile-schema.js";

export class PermissionRuleMatcher {
  private readonly profile: PermissionProfile;

  public constructor(document: PermissionProfileDocument) {
    const profile = document.profiles[document.activeProfile];
    if (profile === undefined) {
      throw new Error(`Active permission profile does not exist: ${document.activeProfile}.`);
    }
    this.profile = profile;
  }

  public policy(policyId: string): PermissionRuleDecision {
    return this.profile.approval.policyRules[policyId] ?? "ask";
  }

  public command(command: string): PermissionRuleDecision {
    return matchingRule(this.profile.approval.commandRules, normalizeCommand(command)) ?? "ask";
  }

  public mcp(target: string): PermissionRuleDecision {
    return matchingRule(this.profile.approval.mcpRules, target.trim()) ?? "ask";
  }

  public resolve(
    request: {
      readonly capabilities?: readonly string[] | undefined;
      readonly policyId: string;
      readonly subject: string;
      readonly toolName: string;
    },
    fallback: PermissionRuleDecision,
  ): PermissionRuleDecision {
    const specific =
      request.toolName === "bashTool"
        ? matchingRule(this.profile.approval.commandRules, normalizeCommand(request.subject))
        : request.policyId === "mcp-external-side-effect"
          ? matchingRule(this.profile.approval.mcpRules, request.subject.trim())
          : undefined;
    const policy = this.profile.approval.policyRules[request.policyId];
    const network = isNetworkOnlyRequest(request.capabilities)
      ? this.profile.network.default
      : undefined;

    if (specific === "deny" || policy === "deny" || network === "deny") {
      return "deny";
    }
    return specific ?? policy ?? network ?? fallback;
  }
}

function isNetworkOnlyRequest(capabilities: readonly string[] | undefined): boolean {
  return (
    capabilities?.includes("network.connect") === true &&
    capabilities.every(
      (capability) => capability === "network.connect" || capability === "process.execute",
    )
  );
}

function matchingRule(
  rules: Readonly<Record<string, PermissionRuleDecision>>,
  subject: string,
): PermissionRuleDecision | undefined {
  const matches = Object.entries(rules)
    .filter(([pattern]) => wildcardMatches(pattern, subject))
    .toSorted(([left], [right]) => specificity(right) - specificity(left));
  if (matches.some(([, decision]) => decision === "deny")) {
    return "deny";
  }
  return matches[0]?.[1];
}

function wildcardMatches(pattern: string, subject: string): boolean {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern) {
    return false;
  }
  if (!normalizedPattern.includes("*")) {
    return normalizedPattern === subject;
  }

  const parts = normalizedPattern.split("*");
  let offset = 0;
  if (!(parts[0] === "" || subject.startsWith(parts[0] as string))) {
    return false;
  }

  for (const [index, part] of parts.entries()) {
    if (!part) {
      continue;
    }
    const found = subject.indexOf(part, offset);
    if (found === -1 || (index === 0 && found !== 0)) {
      return false;
    }
    offset = found + part.length;
  }

  const last = parts[parts.length - 1] as string;
  return last === "" || subject.endsWith(last);
}

function normalizeCommand(command: string): string {
  return command.trim().replaceAll(/\s+/gu, " ");
}

function specificity(pattern: string): number {
  return pattern.replaceAll("*", "").length;
}
