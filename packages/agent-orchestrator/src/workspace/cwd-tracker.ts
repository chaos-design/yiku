import { isAbsolute, resolve } from "node:path";

export interface WorkspaceCwdChange {
  readonly newCwd: string;
  readonly oldCwd: string;
}

export interface CwdTrackerOptions {
  readonly initialCwd: string;
  readonly onChange: (
    change: WorkspaceCwdChange,
  ) => Promise<string | undefined> | string | undefined;
}

export class CwdTracker {
  private cwd: string;

  public constructor(private readonly options: CwdTrackerOptions) {
    if (!isAbsolute(options.initialCwd)) {
      throw new Error("Initial working directory must be absolute.");
    }
    this.cwd = resolve(options.initialCwd);
  }

  public current(): string {
    return this.cwd;
  }

  public async update(nextCwd: string): Promise<string> {
    if (!isAbsolute(nextCwd)) {
      throw new Error("Updated working directory must be absolute.");
    }

    const resolved = resolve(nextCwd);
    if (resolved === this.cwd) {
      return this.cwd;
    }

    const modified = await this.options.onChange({
      newCwd: resolved,
      oldCwd: this.cwd,
    });

    if (modified !== undefined && !isAbsolute(modified)) {
      throw new Error("CwdChanged Hook must return an absolute path.");
    }

    const accepted = modified === undefined ? resolved : resolve(modified);
    this.cwd = accepted;
    return this.cwd;
  }
}
