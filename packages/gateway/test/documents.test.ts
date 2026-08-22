import { describe, expect, it } from "vitest";
import { acceptFileBytes, attachmentDisposition, safeFilename } from "../src/hermes-bridge/documents.ts";

describe("document attachments", () => {
  it("accepts common documents only when their lightweight content check agrees", () => {
    expect(acceptFileBytes("application/pdf", new TextEncoder().encode("%PDF-1.7\n"))).toMatchObject({ ext: "pdf" });
    expect(acceptFileBytes("application/json", new TextEncoder().encode('{"ok":true}'))).toMatchObject({ ext: "json" });
    expect(() => acceptFileBytes("application/pdf", new TextEncoder().encode("not a pdf"))).toThrow(/did not match/);
    expect(() => acceptFileBytes("application/octet-stream", new Uint8Array([1]))).toThrow(/disallowed/);
  });

  it("turns an untrusted filename into download-only response metadata", () => {
    expect(safeFilename("../../report.pdf")).toBe("report.pdf");
    expect(safeFilename("\r\n")).toBeUndefined();
    expect(attachmentDisposition("résumé.pdf")).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
  });
});
