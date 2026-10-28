import path from "node:path";

/** Versioned payload policy (spec 10.3 + D-012). Any change needs a new version, fixtures, and tests. */
export const PAYLOAD_POLICY_VERSION = "payload-v2";

export const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".sh", ".bash", ".zsh", ".ps1", ".css", ".html", ".xml", ".csv", ".svg",
]);

/** Inert raster images: verified by magic bytes, size-capped, never rendered or decoded beyond the header. */
export const IMAGE_EXTENSIONS: Record<string, "png" | "jpeg" | "gif" | "webp"> = {
  ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".gif": "gif", ".webp": "webp",
};
export const MAX_IMAGE_BYTES = 1024 * 1024;

const LICENSE_FILE = /^(LICEN[CS]E|NOTICE|COPYING)([-.](txt|md|MIT|APACHE|BSD))?$/i;

export type FileKind = "text" | "image" | "license" | "unsupported";

/** Classifies by name only; content checks (UTF-8 decoding, magic bytes) happen in review. */
export function classifyPath(relPath: string): FileKind {
  const base = path.posix.basename(relPath);
  if (LICENSE_FILE.test(base)) return "license";
  const ext = path.posix.extname(base).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (ext in IMAGE_EXTENSIONS) return "image";
  return "unsupported";
}

const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  png: (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v),
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => b.length >= 6 && /^GIF8[79]a$/.test(Buffer.from(b.subarray(0, 6)).toString("latin1")),
  webp: (b) => b.length >= 12 && Buffer.from(b.subarray(0, 4)).toString("latin1") === "RIFF" && Buffer.from(b.subarray(8, 12)).toString("latin1") === "WEBP",
};

/** True when the bytes carry the signature of the format the extension claims. */
export function imageMatchesExtension(relPath: string, bytes: Uint8Array): boolean {
  const fmt = IMAGE_EXTENSIONS[path.posix.extname(relPath).toLowerCase()];
  return fmt !== undefined && MAGIC[fmt]!(bytes);
}
