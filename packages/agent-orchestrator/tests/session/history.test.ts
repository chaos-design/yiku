import { describe, expect, it } from "vitest";
import { SessionHistory } from "../../src/session/history.js";

describe("SessionHistory", () => {
  it("stores immutable normalized entries", () => {
    const history = new SessionHistory();
    history.append("user", "  first  ");
    history.append("assistant", "");

    expect(history.list()).toEqual([{ content: "first", role: "user" }]);
    expect(Object.isFrozen(history.list())).toBe(true);
    expect(Object.isFrozen(history.list()[0])).toBe(true);
  });

  it("renders recent escaped context within a character budget", () => {
    const history = new SessionHistory();
    history.append("user", "<first>");
    history.append("assistant", 'second & "quoted"');

    const rendered = history.render(1_000);

    expect(rendered).toContain("&lt;first&gt;");
    expect(rendered).toContain("second &amp; &quot;quoted&quot;");
    expect(rendered).not.toContain("<first>");
    expect(history.render(120)).toContain("second");
    expect(history.render(20)).toBeUndefined();
  });

  it("clears all entries", () => {
    const history = new SessionHistory();
    history.append("user", "first");
    history.clear();

    expect(history.list()).toEqual([]);
    expect(history.render(1_000)).toBeUndefined();
  });

  it("restores persisted entries and returns frozen snapshots", () => {
    const history = new SessionHistory([
      { content: " restored user ", role: "user" },
      { content: "restored answer", role: "assistant" },
    ]);

    expect(history.snapshot()).toEqual([
      { content: "restored user", role: "user" },
      { content: "restored answer", role: "assistant" },
    ]);
    expect(Object.isFrozen(history.snapshot())).toBe(true);

    history.restore([{ content: "summary", role: "system" }]);
    expect(history.snapshot()).toEqual([{ content: "summary", role: "system" }]);
  });
});
