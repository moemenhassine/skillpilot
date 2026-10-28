import { createHash } from "node:crypto";

/**
 * Deterministic JSON (spec 12.2): lexicographically sorted object keys, array order preserved,
 * no insignificant whitespace, finite numbers only, undefined members omitted.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite number in canonical JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new Error(`Unsupported value in canonical JSON: ${typeof value}`);
}

export const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Domain-separated digest so different object kinds can never share a hash. */
export const domainDigest = (domain: string, value: unknown) => `sha256:${sha256Hex(`${domain}\n${canonicalJson(value)}`)}`;
