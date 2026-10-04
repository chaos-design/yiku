import { HookConfigCompiler } from "./compiler.js";
import type { HookConfigCompilation, HookConfigDocument, HookConfigSnapshotView } from "./types.js";

export class HookConfigReloader {
  private snapshot: HookConfigSnapshotView;

  public constructor(
    private readonly compiler = new HookConfigCompiler(),
    initialDocuments: readonly HookConfigDocument[] = [],
  ) {
    this.snapshot = compiler.compile(initialDocuments).snapshot;
  }

  public current(): HookConfigSnapshotView {
    return this.snapshot;
  }

  public reload(documents: readonly HookConfigDocument[]): HookConfigCompilation {
    const compilation = this.compiler.compile(documents);
    this.snapshot = compilation.snapshot;
    return compilation;
  }
}
