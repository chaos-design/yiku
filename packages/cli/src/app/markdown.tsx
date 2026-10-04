import { Box, Text } from "ink";
import { lexer, type Token, type Tokens } from "marked";
import type { ReactNode } from "react";
import stringWidth from "string-width";
import { LAYOUT_SPACING } from "./constants.js";

const MAX_TABLE_COLUMN_WIDTH = 32;
const TABLE_CELL_PADDING = 1;

export function MarkdownMessage({ text }: { readonly text: string }) {
  const tokens = lexMarkdown(text);

  if (tokens === undefined) {
    return <Text color="white">{text}</Text>;
  }

  return (
    <Box flexDirection="column">
      {withTokenKeys(tokens).map(({ key, value }) => (
        <BlockToken key={key} token={value} />
      ))}
    </Box>
  );
}

function BlockToken({ token }: { readonly token: Token }) {
  switch (token.type) {
    case "space":
    case "def":
      return null;
    case "heading":
      return <HeadingToken token={token as Tokens.Heading} />;
    case "paragraph":
      return <ParagraphToken token={token as Tokens.Paragraph} />;
    case "text":
      return <TextTokenBlock token={token as Tokens.Text} />;
    case "list":
      return <ListToken depth={0} token={token as Tokens.List} />;
    case "table":
      return <TableToken token={token as Tokens.Table} />;
    case "code":
      return <CodeToken token={token as Tokens.Code} />;
    case "blockquote":
      return <BlockquoteToken token={token as Tokens.Blockquote} />;
    case "hr":
      return null;
    case "html":
      return <HtmlToken token={token as Tokens.HTML} />;
    default:
      return <FallbackToken token={token} />;
  }
}

function HeadingToken({ token }: { readonly token: Tokens.Heading }) {
  return (
    <Box marginBottom={LAYOUT_SPACING.item} marginTop={token.depth > 1 ? LAYOUT_SPACING.item : 0}>
      <Text bold color="magenta">
        <InlineTokens tokens={token.tokens} />
      </Text>
    </Box>
  );
}

function ParagraphToken({ token }: { readonly token: Tokens.Paragraph }) {
  return (
    <Box marginBottom={LAYOUT_SPACING.item}>
      <Text color="white">
        <InlineTokens tokens={token.tokens} />
      </Text>
    </Box>
  );
}

function TextTokenBlock({ token }: { readonly token: Tokens.Text }) {
  return (
    <Box marginBottom={LAYOUT_SPACING.item}>
      <Text color={getStatusColor(token.text) ?? "white"}>
        {token.tokens ? <InlineTokens tokens={token.tokens} /> : token.text}
      </Text>
    </Box>
  );
}

function ListToken({ depth, token }: { readonly depth: number; readonly token: Tokens.List }) {
  return (
    <Box
      flexDirection="column"
      marginBottom={depth === 0 ? LAYOUT_SPACING.item : 0}
      marginLeft={depth * 2}
    >
      {withKeys(
        token.items,
        (item) => `${item.raw}:${item.checked === undefined ? "plain" : String(item.checked)}`,
      ).map(({ key, value }, position) => (
        <ListItem
          depth={depth}
          key={key}
          marker={getListMarker(token, value, position)}
          token={value}
        />
      ))}
    </Box>
  );
}

function ListItem({
  depth,
  marker,
  token,
}: {
  readonly depth: number;
  readonly marker: string;
  readonly token: Tokens.ListItem;
}) {
  const inlineToken = token.tokens.find(
    (child) => child.type === "text" || child.type === "paragraph",
  );
  const nestedLists = token.tokens.filter((child) => child.type === "list") as Tokens.List[];

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={token.checked === true ? "green" : token.task ? "yellow" : "gray"}>
          {marker}{" "}
        </Text>
        <Text color="white">
          {inlineToken ? <InlineTokens tokens={getInlineTokens(inlineToken)} /> : token.text}
        </Text>
      </Box>
      {withKeys(nestedLists, (list) => list.raw).map(({ key, value }) => (
        <ListToken depth={depth + 1} key={key} token={value} />
      ))}
    </Box>
  );
}

function TableToken({ token }: { readonly token: Tokens.Table }) {
  const rows = [token.header, ...token.rows];
  const widths = getTableColumnWidths(rows);

  return (
    <Box flexDirection="column" marginBottom={LAYOUT_SPACING.item}>
      <TableRow cells={token.header} header widths={widths} />
      <Text color="gray">{formatTableSeparator(widths)}</Text>
      {withKeys(token.rows, (row) => row.map((cell) => cell.text).join("|")).map(
        ({ key, value }) => (
          <TableRow cells={value} key={key} widths={widths} />
        ),
      )}
    </Box>
  );
}

function TableRow({
  cells,
  header = false,
  widths,
}: {
  readonly cells: readonly Tokens.TableCell[];
  readonly header?: boolean | undefined;
  readonly widths: readonly number[];
}) {
  return (
    <Text>
      {withKeys(cells, (cell) => `${cell.text}:${cell.align ?? "none"}`).map(
        ({ key, value }, position) => {
          const text = getInlineText(value.tokens);
          const padded = padTableCell(text, widths[position] ?? text.length, value.align);

          return (
            <Text
              bold={header}
              color={header ? "cyan" : (getStatusColor(text) ?? "white")}
              key={key}
            >
              {position === 0 ? "" : "│ "}
              {padded}
              {" ".repeat(TABLE_CELL_PADDING)}
            </Text>
          );
        },
      )}
    </Text>
  );
}

function CodeToken({ token }: { readonly token: Tokens.Code }) {
  return (
    <Box
      borderColor="gray"
      borderStyle="single"
      flexDirection="column"
      marginBottom={LAYOUT_SPACING.item}
      paddingX={1}
    >
      {token.lang ? <Text color="cyan">{token.lang}</Text> : null}
      <Text color="white" wrap="wrap">
        {token.text}
      </Text>
    </Box>
  );
}

function BlockquoteToken({ token }: { readonly token: Tokens.Blockquote }) {
  return (
    <Box flexDirection="row" marginBottom={LAYOUT_SPACING.item}>
      <Text color="gray">│ </Text>
      <Box flexDirection="column">
        {withTokenKeys(token.tokens).map(({ key, value }) => (
          <BlockToken key={key} token={value} />
        ))}
      </Box>
    </Box>
  );
}

function HtmlToken({ token }: { readonly token: Tokens.HTML }) {
  const text = stripHtml(token.text);

  return text ? <Text color="white">{text}</Text> : null;
}

function FallbackToken({ token }: { readonly token: Token }) {
  const text = getTokenText(token);

  return text ? <Text color="white">{text}</Text> : null;
}

function InlineTokens({ tokens }: { readonly tokens: readonly Token[] }) {
  return (
    <>
      {withTokenKeys(tokens).map(({ key, value }) => (
        <InlineToken key={key} token={value} />
      ))}
    </>
  );
}

function InlineToken({ token }: { readonly token: Token }): ReactNode {
  switch (token.type) {
    case "strong": {
      const strong = token as Tokens.Strong;
      return (
        <Text bold color="white">
          <InlineTokens tokens={strong.tokens} />
        </Text>
      );
    }
    case "em": {
      const emphasis = token as Tokens.Em;
      return (
        <Text italic color="white">
          <InlineTokens tokens={emphasis.tokens} />
        </Text>
      );
    }
    case "codespan":
      return <Text color="green">{(token as Tokens.Codespan).text}</Text>;
    case "del": {
      const deletion = token as Tokens.Del;
      return (
        <Text color="gray" strikethrough>
          <InlineTokens tokens={deletion.tokens} />
        </Text>
      );
    }
    case "link": {
      const link = token as Tokens.Link;
      return (
        <>
          <Text color="cyan" underline>
            <InlineTokens tokens={link.tokens} />
          </Text>
          <Text color="green"> ({link.href})</Text>
        </>
      );
    }
    case "image": {
      const image = token as Tokens.Image;
      return (
        <Text color="cyan">
          [image: {image.text}] ({image.href})
        </Text>
      );
    }
    case "br":
      return "\n";
    case "html":
      return stripHtml((token as Tokens.HTML).text);
    case "escape":
      return (token as Tokens.Escape).text;
    case "text": {
      const text = token as Tokens.Text;
      const statusColor = getStatusColor(text.text);

      return text.tokens ? (
        <InlineTokens tokens={text.tokens} />
      ) : statusColor ? (
        <Text color={statusColor}>{text.text}</Text>
      ) : (
        text.text
      );
    }
    default:
      return getTokenText(token);
  }
}

function lexMarkdown(text: string): readonly Token[] | undefined {
  if (hasUnclosedFence(text)) {
    return undefined;
  }

  try {
    return lexer(text, {
      breaks: true,
      gfm: true,
    });
  } catch {
    return undefined;
  }
}

function hasUnclosedFence(text: string): boolean {
  const fences = text.match(/^ {0,3}(```|~~~)/gmu);

  return (fences?.length ?? 0) % 2 === 1;
}

function getListMarker(token: Tokens.List, item: Tokens.ListItem, position: number): string {
  if (item.task) {
    return item.checked ? "✅" : "☐";
  }

  if (token.ordered) {
    const start = typeof token.start === "number" ? token.start : 1;
    return `${start + position}.`;
  }

  return "•";
}

function getInlineTokens(token: Token): readonly Token[] {
  if ("tokens" in token && Array.isArray(token.tokens)) {
    return token.tokens;
  }

  return [token];
}

function getTableColumnWidths(rows: readonly (readonly Tokens.TableCell[])[]): readonly number[] {
  const columnCount = Math.max(0, ...rows.map((row) => row.length));

  return Array.from({ length: columnCount }, (_, columnIndex) => {
    const width = Math.max(
      1,
      ...rows.map((row) => stringWidth(getInlineText(row[columnIndex]?.tokens ?? []))),
    );

    return Math.min(width, MAX_TABLE_COLUMN_WIDTH);
  });
}

function padTableCell(text: string, width: number, align: Tokens.TableCell["align"]): string {
  const bounded = truncateTableCell(text, width);
  const remaining = Math.max(0, width - stringWidth(bounded));

  if (align === "right") {
    return `${" ".repeat(remaining)}${bounded}`;
  }

  if (align === "center") {
    const left = Math.floor(remaining / 2);
    return `${" ".repeat(left)}${bounded}${" ".repeat(remaining - left)}`;
  }

  return `${bounded}${" ".repeat(remaining)}`;
}

function truncateTableCell(text: string, width: number): string {
  if (stringWidth(text) <= width) {
    return text;
  }

  const maximum = Math.max(0, width - 1);
  let value = "";
  for (const character of text) {
    if (stringWidth(`${value}${character}`) > maximum) {
      break;
    }
    value += character;
  }
  return `${value}…`;
}

function formatTableSeparator(widths: readonly number[]): string {
  return widths.map((width) => "─".repeat(width + TABLE_CELL_PADDING)).join("┼ ");
}

function getInlineText(tokens: readonly Token[]): string {
  return tokens.map((token) => getTokenText(token)).join("");
}

function getTokenText(token: Token): string {
  if (token.type === "br") {
    return "\n";
  }

  if ("tokens" in token && Array.isArray(token.tokens)) {
    return getInlineText(token.tokens);
  }

  if ("text" in token && typeof token.text === "string") {
    return stripHtml(token.text);
  }

  return "";
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/gu, "");
}

function getStatusColor(text: string): "green" | "red" | "yellow" | undefined {
  if (text.includes("✅")) {
    return "green";
  }

  if (text.includes("❌")) {
    return "red";
  }

  if (text.includes("⚠")) {
    return "yellow";
  }

  return undefined;
}

function withTokenKeys(tokens: readonly Token[]) {
  return withKeys(tokens, (token) => `${token.type}:${token.raw}`);
}

function withKeys<T>(values: readonly T[], getBaseKey: (value: T) => string) {
  const occurrences = new Map<string, number>();

  return values.map((value) => {
    const baseKey = getBaseKey(value);
    const occurrence = occurrences.get(baseKey) ?? 0;
    occurrences.set(baseKey, occurrence + 1);

    return {
      key: `${baseKey}:${occurrence}`,
      value,
    };
  });
}
