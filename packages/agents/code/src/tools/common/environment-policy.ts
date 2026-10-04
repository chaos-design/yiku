const DEFAULT_ALLOWED_NAMES = new Set([
  "CI",
  "COLORTERM",
  "HOME",
  "LANG",
  "NO_COLOR",
  "PATH",
  "TERM",
  "TMPDIR",
]);

const DENIED_NAME_PATTERNS = [
  /API_KEY/i,
  /TOKEN/i,
  /SECRET/i,
  /PASSWORD/i,
  /CREDENTIAL/i,
  /^AWS_/i,
  /^AZURE_/i,
  /^GCP_/i,
] as const;

export interface EnvironmentPolicyOptions {
  readonly allowedNames?: readonly string[] | undefined;
}

export class EnvironmentPolicy {
  public readonly allowedNames: ReadonlySet<string>;
  public readonly deniedPatterns: readonly RegExp[] = DENIED_NAME_PATTERNS;

  public constructor(options: EnvironmentPolicyOptions = {}) {
    const allowedNames = new Set(DEFAULT_ALLOWED_NAMES);
    for (const name of options.allowedNames ?? []) {
      const normalized = normalizeName(name);
      if (isDeniedName(normalized)) {
        throw new Error(`Environment variable cannot be exposed to tools: ${normalized}.`);
      }
      allowedNames.add(normalized);
    }
    this.allowedNames = allowedNames;
  }

  public buildProcessEnv(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(input)) {
      if (
        value !== undefined &&
        !isDeniedName(name) &&
        (this.allowedNames.has(name) || name.startsWith("LC_"))
      ) {
        environment[name] = value;
      }
    }
    return environment;
  }
}

function normalizeName(name: string): string {
  const normalized = name.trim();
  if (!normalized) {
    throw new Error("Environment variable name must be non-empty.");
  }
  return normalized;
}

function isDeniedName(name: string): boolean {
  return DENIED_NAME_PATTERNS.some((pattern) => pattern.test(name));
}
