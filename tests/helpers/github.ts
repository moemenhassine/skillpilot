import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { HttpResponse, Transport } from "../../src/fetcher/github.ts";

export type Responses = Record<string, unknown | HttpResponse>;

const isHttp = (v: unknown): v is HttpResponse => typeof v === "object" && v !== null && "status" in v && "body" in v;

/** Transport backed by a path→JSON map; records every URL it receives. */
export function fixtureTransport(responses: Responses) {
  const urls: URL[] = [];
  const transport: Transport = async (url) => {
    urls.push(url);
    const v = responses[`${url.pathname}${url.search}`];
    if (v === undefined) return { status: 404, headers: {}, body: Buffer.from('{"message":"Not Found"}') };
    if (isHttp(v)) return v;
    return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(v)) };
  };
  return { transport, urls };
}

export function recorded(name: string): Responses {
  return JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../fixtures/github", name, "responses.json"), "utf8")).responses;
}

export const gitSha = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/** Builds a consistent synthetic repository: repo, branch, tree, and blobs with real Git object IDs. */
export function syntheticRepo(
  full: string,
  files: Record<string, string | Buffer>,
  opts: { commit?: string; truncated?: boolean; license?: string | null; extraTree?: { path: string; mode: string; type: string; sha: string; size?: number }[] } = {},
): Responses {
  const commit = opts.commit ?? "a".repeat(40);
  const out: Responses = {
    [`/repos/${full}`]: { full_name: full, private: false, default_branch: "main", license: opts.license === null ? null : { spdx_id: opts.license ?? "MIT" } },
    [`/repos/${full}/branches/main`]: { commit: { sha: commit } },
  };
  const tree = Object.entries(files).sort().map(([p, content]) => {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const sha = gitSha(bytes);
    out[`/repos/${full}/git/blobs/${sha}`] = { sha, size: bytes.length, encoding: "base64", content: bytes.toString("base64") };
    return { path: p, mode: "100644", type: "blob", sha, size: bytes.length };
  });
  out[`/repos/${full}/git/trees/${commit}?recursive=1`] = { sha: "t".repeat(40), truncated: opts.truncated ?? false, tree: [...tree, ...(opts.extraTree ?? [])] };
  return out;
}

export const skillMd = (name: string, description = `Helps with ${name}.`) => `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`;

export const MIT = "MIT License\n\nCopyright (c) 2026 Example\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.\n";
/** Smallest valid PNG signature + IHDR header; never decoded. */
export const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
