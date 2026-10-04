import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { MarkdownMessage } from "../../src/app/markdown.js";

describe("MarkdownMessage", () => {
  it("renders GFM headings, tables, lists, and inline styles", () => {
    const app = render(
      <MarkdownMessage
        text={[
          "## Check results",
          "",
          "| Item | Result |",
          "| --- | --- |",
          "| Type check (`tsc -b`) | ✅ Passed |",
          "| Lint | ❌ Failed |",
          "",
          "1. **Import order** uses `organizeImports`.",
          "2. *Formatting* needs attention.",
          "",
          "- [x] Tests",
          "- [ ] Lint",
          "",
          "[Docs](https://example.test)",
          "",
          "~~obsolete~~",
        ].join("\n")}
      />,
    );
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("Check results");
    expect(frame).toContain("Item");
    expect(frame).toContain("Result");
    expect(frame).toContain("Type check (tsc -b)");
    expect(frame).toContain("✅ Passed");
    expect(frame).toContain("❌ Failed");
    expect(frame).toContain("1. Import order uses organizeImports.");
    expect(frame).toContain("2. Formatting needs attention.");
    expect(frame).toContain("✅ Tests");
    expect(frame).toContain("☐ Lint");
    expect(frame).toContain("Docs (https://example.test)");
    expect(frame).toContain("obsolete");
    expect(frame).not.toMatch(/[╭╮╰╯]/u);

    app.unmount();
  });

  it("renders code blocks, blockquotes, images, and visible HTML text without rules", () => {
    const app = render(
      <MarkdownMessage
        text={[
          "> Important result",
          "",
          "---",
          "",
          "```ts",
          "const result = true;",
          "```",
          "",
          "![report](report.png)",
          "",
          "<strong>visible</strong>",
        ].join("\n")}
      />,
    );
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("│");
    expect(frame).toContain("Important result");
    expect(frame).toContain("ts");
    expect(frame).toContain("const result = true;");
    expect(frame).toContain("[image: report] (report.png)");
    expect(frame).toContain("visible");
    expect(frame).not.toContain("<strong>");

    app.unmount();
  });

  it("omits horizontal rules between markdown modules", () => {
    const app = render(<MarkdownMessage text={"Before\n\n---\n\nAfter"} />);
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("Before");
    expect(frame).toContain("After");
    expect(frame).not.toContain("─");
    app.unmount();
  });

  it("aligns table columns by terminal width for CJK content", () => {
    const app = render(
      <MarkdownMessage
        text={[
          "| 标题 | Result |",
          "| --- | --- |",
          "| 组件实验室 | Passed |",
          "| React | Failed |",
        ].join("\n")}
      />,
    );
    const lines = (app.lastFrame() ?? "")
      .split("\n")
      .filter(
        (line) => line.includes("Result") || line.includes("Passed") || line.includes("Failed"),
      );
    const separatorWidths = lines.map((line) => {
      const separator = line.indexOf("│", 1);
      return stringWidth(line.slice(0, separator));
    });

    expect(new Set(separatorWidths)).toEqual(new Set([separatorWidths[0]]));
    app.unmount();
  });

  it("falls back to plain text for an unfinished fenced code block", () => {
    const text = "```ts\nconst unfinished = true;";
    const app = render(<MarkdownMessage text={text} />);
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("```ts");
    expect(frame).toContain("const unfinished = true;");

    app.unmount();
  });

  it("renders nested lists, aligned tables, hard breaks, and code without a language", () => {
    const longCell = "x".repeat(40);
    const app = render(
      <MarkdownMessage
        text={[
          "# Primary heading",
          "",
          "- Parent",
          "  - Nested",
          "",
          "3. Third",
          "4. Fourth",
          "",
          "| Left | Center | Right |",
          "| :--- | :---: | ---: |",
          `| ${longCell} | centered | 42 |`,
          "",
          "first line  ",
          "second line",
          "",
          "⚠ Warning",
          "",
          "```",
          "plain code",
          "```",
        ].join("\n")}
      />,
    );
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("Primary heading");
    expect(frame).toContain("• Parent");
    expect(frame).toContain("• Nested");
    expect(frame).toContain("3. Third");
    expect(frame).toContain("4. Fourth");
    expect(frame).toContain("centered");
    expect(frame).toContain("42");
    expect(frame).toContain(`${"x".repeat(31)}…`);
    expect(frame).toContain("first line");
    expect(frame).toContain("second line");
    expect(frame).toContain("⚠ Warning");
    expect(frame).toContain("plain code");

    app.unmount();
  });

  it("renders block HTML, escapes, autolinks, and empty HTML safely", () => {
    const app = render(
      <MarkdownMessage
        text={[
          "<div>visible block</div>",
          "",
          "<br>",
          "",
          "\\*escaped\\*",
          "",
          "<https://example.test/path>",
        ].join("\n")}
      />,
    );
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("visible block");
    expect(frame).not.toContain("<div>");
    expect(frame).not.toContain("<br>");
    expect(frame).toContain("*escaped*");
    expect(frame).toContain("https://example.test/path");

    app.unmount();
  });

  it("renders an empty parent list item and strips empty block HTML", () => {
    const app = render(
      <MarkdownMessage
        text={[
          "- ",
          "  - nested only",
          "",
          "<br>",
          "",
          "| a | b |",
          "|---|---|",
          "| x<br>y | z |",
        ].join("\n")}
      />,
    );
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("nested only");
    expect(frame).toContain("xy");
    expect(frame).not.toContain("<br>");

    app.unmount();
  });
});
