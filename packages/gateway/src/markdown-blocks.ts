import type { ListItem, RichBlock } from "cozygateway-contract";

/** Line-oriented markdown to typed-blocks normalization.
 *
 *  A TypeScript port of the reference Python normalizer
 *  (`integrations/attach-plugin/cozygateway/text_blocks.py`, `normalize_text_to_blocks`),
 *  byte-identical to it per the cross-language parity vectors in
 *  `test/fixtures/markdown-blocks-vectors.json`. Converts a run of accumulated model text
 *  (markdown) into the closed `RichBlock` union before the gateway or the client sees it; the
 *  renderer runs no markdown parser of its own, it renders only the typed blocks this produces.
 *
 *  Deliberately NOT a general CommonMark engine: it emits only the closed set, never HTML, never
 *  resolves links or images, and treats inline emphasis / links / inline code as inert literal
 *  text carried in a block's plain `text` (the renderer escapes it), so nothing structural can be
 *  injected across the boundary.
 *
 *  v0 is non-incremental: every call re-normalizes the whole accumulated buffer from scratch. The
 *  incremental optimization (a stable-prefix cache, mirroring the Python `IncrementalNormalizer`)
 *  is out of scope here (spec section 11).
 *
 *  Dispatch order per line: blank, fence, math, heading, table, list, paragraph.
 */

const FENCE_RE = /^```(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^\s*[-*+]\s+(.*)$/;
const ORDERED_RE = /^\s*\d+[.)]\s+(.*)$/;
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;
const TABLE_SEP_RE = /^\|?[\s:|-]+\|?$/;

export function normalizeMarkdownToBlocks(text: string): RichBlock[] {
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return normalizeLines(lines);
}

function normalizeLines(lines: string[]): RichBlock[] {
  const blocks: RichBlock[] = [];
  let para: string[] = [];

  const flushParagraph = () => {
    const joined = para.join("\n").trim();
    if (joined) {
      blocks.push({ type: "paragraph", text: joined });
    }
    para = [];
  };

  let index = 0;
  const total = lines.length;
  while (index < total) {
    const line = lines[index]!;

    // Blank line: paragraph boundary.
    if (line.trim() === "") {
      flushParagraph();
      index += 1;
      continue;
    }

    // Fenced code: capture verbatim to the closing fence (or to EOF, for a still-streaming
    // draft; an unterminated trailing fence still emits a code block).
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushParagraph();
      const language = fence[1]!.trim();
      const body: string[] = [];
      index += 1;
      while (index < total && !lines[index]!.startsWith("```")) {
        body.push(lines[index]!);
        index += 1;
      }
      // index now sits on the closing fence (or past EOF); step over it.
      blocks.push(
        language
          ? { type: "code", code: body.join("\n"), language }
          : { type: "code", code: body.join("\n") },
      );
      index += 1;
      continue;
    }

    // Display math.
    if (line.trim() === "$$") {
      flushParagraph();
      const mathBody: string[] = [];
      index += 1;
      while (index < total && lines[index]!.trim() !== "$$") {
        mathBody.push(lines[index]!);
        index += 1;
      }
      blocks.push({ type: "math", latex: mathBody.join("\n").trim() });
      index += 1;
      continue;
    }

    // ATX heading (deeper than 3 clamps to 3).
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph();
      const level = Math.min(heading[1]!.length, 3) as 1 | 2 | 3;
      blocks.push({ type: "heading", level, text: heading[2]!.trim() });
      index += 1;
      continue;
    }

    // Pipe table: a header row followed immediately by a separator row.
    if (isTableRow(line) && index + 1 < total && isTableSeparator(lines[index + 1]!)) {
      flushParagraph();
      const header = splitTableRow(line);
      const rows: string[][] = [];
      index += 2; // skip the header and the separator
      while (index < total && isTableRow(lines[index]!)) {
        rows.push(splitTableRow(lines[index]!));
        index += 1;
      }
      // index now sits on the first non-row line; it is handled next.
      blocks.push({ type: "table", header, rows });
      continue;
    }

    // List: a run of consecutive bullet / ordered items (task items included).
    const marker = listMarker(line);
    if (marker !== null) {
      flushParagraph();
      const items: ListItem[] = [];
      let ordered = false;
      while (index < total) {
        const m = listMarker(lines[index]!);
        if (m === null) break;
        ordered = m[0];
        items.push(parseItem(m[1]));
        index += 1;
      }
      // index now sits on the first non-list line; it is handled next.
      blocks.push({ type: "list", items, ordered });
      continue;
    }

    // Otherwise accumulate into the current paragraph.
    para.push(line);
    index += 1;
  }

  flushParagraph();
  return blocks;
}

function listMarker(line: string): [boolean, string] | null {
  const bullet = BULLET_RE.exec(line);
  if (bullet) return [false, bullet[1]!];
  const ordered = ORDERED_RE.exec(line);
  if (ordered) return [true, ordered[1]!];
  return null;
}

function parseItem(content: string): ListItem {
  const task = TASK_RE.exec(content);
  if (task) {
    return { text: task[2]!.trim(), checked: task[1]!.toLowerCase() === "x" };
  }
  return { text: content.trim() };
}

function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim() !== "";
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("-") && TABLE_SEP_RE.test(trimmed);
}

function splitTableRow(line: string): string[] {
  let stripped = line.trim();
  stripped = stripped.replace(/^\|/, "");
  stripped = stripped.replace(/\|$/, "");
  return stripped.split("|").map((cell) => cell.trim());
}
