export class ShellSandboxUnavailableError extends Error {
  public override readonly name = "ShellSandboxUnavailableError";
  public readonly code = "SHELL_SANDBOX_UNAVAILABLE";

  public constructor(
    public readonly platform: string,
    message: string,
  ) {
    super(`[SHELL_SANDBOX_UNAVAILABLE] ${message}`);
  }
}
