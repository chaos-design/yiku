export type SessionHistoryRole = "assistant" | "system" | "user";

export interface SessionHistoryEntry {
  readonly content: string;
  readonly role: SessionHistoryRole;
}

export class SessionHistory {
  private readonly entries: SessionHistoryEntry[] = [];

  public constructor(entries: readonly SessionHistoryEntry[] = []) {
    this.restore(entries);
  }

  public append(role: SessionHistoryRole, content: string): void {
    const normalized = content.trim();
    if (!normalized) {
      return;
    }

    this.entries.push(
      Object.freeze({
        content: normalized,
        role,
      }),
    );
  }

  public list(): readonly SessionHistoryEntry[] {
    return this.snapshot();
  }

  public clear(): void {
    this.entries.length = 0;
  }

  public replace(entries: readonly SessionHistoryEntry[]): void {
    const normalized = entries
      .map((entry) => ({
        content: entry.content.trim(),
        role: entry.role,
      }))
      .filter((entry) => entry.content)
      .map((entry) => Object.freeze(entry));

    this.entries.splice(0, this.entries.length, ...normalized);
  }

  public restore(entries: readonly SessionHistoryEntry[]): void {
    this.replace(entries);
  }

  public snapshot(): readonly SessionHistoryEntry[] {
    return Object.freeze([...this.entries]);
  }

  public render(maxChars: number): string | undefined {
    if (this.entries.length === 0 || maxChars <= 0) {
      return undefined;
    }

    const rendered = this.entries.map(
      (entry) => `<message role="${entry.role}">${escapeXml(entry.content)}</message>`,
    );
    const selected: string[] = [];
    let used = "<conversation_history>\n\n</conversation_history>".length;

    for (let index = rendered.length - 1; index >= 0; index -= 1) {
      const item = rendered[index];
      if (item === undefined || used + item.length + 1 > maxChars) {
        break;
      }
      selected.unshift(item);
      used += item.length + 1;
    }

    return selected.length > 0
      ? `<conversation_history>\n${selected.join("\n")}\n</conversation_history>`
      : undefined;
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
