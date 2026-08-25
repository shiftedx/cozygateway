/** Small, deliberately boring document admission rules. These are shared by the device route and
 * attach-v1 so neither path can smuggle a different kind of file into Hermes. */

export const FILE_MAX_BYTES = 20 * 1024 * 1024;

export const FILE_TYPES = new Map<string, string>([
  ["application/pdf", "pdf"],
  ["text/plain", "txt"], ["text/markdown", "md"], ["text/csv", "csv"],
  ["application/json", "json"], ["application/rtf", "rtf"], ["text/rtf", "rtf"],
  ["application/msword", "doc"],
  ["application/vnd.ms-excel", "xls"],
  ["application/vnd.ms-powerpoint", "ppt"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
  ["application/vnd.oasis.opendocument.text", "odt"],
  ["application/vnd.oasis.opendocument.spreadsheet", "ods"],
  ["application/vnd.oasis.opendocument.presentation", "odp"],
  ["application/zip", "zip"],
]);

const OLE_TYPES = new Set(["application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"]);
/** Every member is a ZIP on the wire, so the magic check is the same for all of them. The declared
 * type is what separates a bare archive from an OOXML or OpenDocument package; the plugin-side
 * probe tells them apart by the package's uncompressed "[Content_Types].xml" entry. */
const ZIP_TYPES = new Set([
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text", "application/vnd.oasis.opendocument.spreadsheet", "application/vnd.oasis.opendocument.presentation",
]);
const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "application/json", "application/rtf", "text/rtf"]);

function starts(bytes: Uint8Array, ...prefix: number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function validText(bytes: Uint8Array, mime: string): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) return false;
    if (mime === "application/json") JSON.parse(text);
    if (mime === "application/rtf" || mime === "text/rtf") return /^\{\\rtf\d*/i.test(text);
    return true;
  } catch { return false; }
}

export function acceptFileBytes(declared: string, bytes: Uint8Array): { mime: string; ext: string } {
  const mime = declared.toLowerCase();
  const ext = FILE_TYPES.get(mime);
  if (ext === undefined) throw new Error("disallowed file type");
  if (bytes.byteLength === 0) throw new Error("file carried no bytes");
  if (bytes.byteLength > FILE_MAX_BYTES) throw new Error("file is over the size cap");
  const valid = mime === "application/pdf" ? starts(bytes, 0x25, 0x50, 0x44, 0x46, 0x2d)
    : OLE_TYPES.has(mime) ? starts(bytes, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)
      : ZIP_TYPES.has(mime) ? starts(bytes, 0x50, 0x4b, 0x03, 0x04) || starts(bytes, 0x50, 0x4b, 0x05, 0x06)
        : TEXT_TYPES.has(mime) && validText(bytes, mime);
  if (!valid) throw new Error("file bytes did not match the declared allowed type");
  return { mime, ext };
}

/** A filename is display/download metadata, never a path. */
export function safeFilename(value: string, fallback = "attachment"): string | undefined {
  const name = value.replace(/[\x00-\x1f\x7f]/g, "").split(/[\\/]/).pop()?.trim() ?? "";
  if (name.length === 0 || name.length > 180) return undefined;
  return name === "." || name === ".." ? fallback : name;
}

export function attachmentDisposition(name: string): string {
  const safe = safeFilename(name) ?? "attachment";
  const ascii = safe.replace(/[^A-Za-z0-9._-]/g, "_") || "attachment";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
