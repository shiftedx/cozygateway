import type { RichBlock } from "cozygateway-contract";

/** Render typed blocks to the plain text a harness receives as its prompt. Deliberately lossy
 *  in the harness direction (markdown-ish, good enough to prompt with); the plugin normalizes
 *  the harness's reply back into typed blocks on its side. */
export function blocksToText(blocks: RichBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
        parts.push(block.text);
        break;
      case "heading":
        parts.push(`${"#".repeat(block.level)} ${block.text}`);
        break;
      case "code":
        parts.push(`\`\`\`${block.language ?? ""}\n${block.code}\n\`\`\``);
        break;
      case "list":
        parts.push(
          block.items
            .map((item, i) => {
              const marker = block.ordered === true ? `${i + 1}.` : "-";
              const box = item.checked === undefined ? "" : item.checked ? "[x] " : "[ ] ";
              return `${marker} ${box}${item.text}`;
            })
            .join("\n"),
        );
        break;
      case "table":
        parts.push(
          [
            `| ${block.header.join(" | ")} |`,
            `| ${block.header.map(() => "---").join(" | ")} |`,
            ...block.rows.map((row) => `| ${row.join(" | ")} |`),
          ].join("\n"),
        );
        break;
      case "math":
        parts.push(`$$\n${block.latex}\n$$`);
        break;
      case "attachment":
        parts.push(`[attachment: ${block.name}]`);
        break;
      default: {
        // Exhaustiveness guard: if RichBlock gains a new kind, `block` here is no longer `never`
        // and this line fails to typecheck, catching the gap at compile time instead of
        // silently dropping the new kind's content at render time.
        const unreachable: never = block;
        throw new Error(`blocksToText: unhandled block type ${(unreachable as { type: string }).type}`);
      }
    }
  }
  return parts.join("\n\n");
}
