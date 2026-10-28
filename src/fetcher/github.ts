import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { SkillpilotError } from "../errors.ts";
import { COMMIT_ID } from "../sources/catalog.ts";

export const API_HOST = "api.github.com";
export const REQUEST_TIMEOUT_MS = 15_000;
export const COMMAND_DEADLINE_MS = 90_000;
export const MAX_RETRIES = 2;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** Injectable transport. Production uses fetch; tests use recorded fixtures. */
export type Transport = (url: URL, signal: AbortSignal) => Promise<HttpResponse>;

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** Production transport: fixed host, no auth headers, no redirects, capped streamed body. */
export const fetchTransport: Transport = async (url, signal) => {
  if (url.protocol !== "https:" || url.hostname !== API_HOST || url.port || url.username || url.password) {
    throw new SkillpilotError("INVALID_ARGUMENT", "Refusing a request to an unapproved host.", "Only public api.github.com requests are allowed.");
  }
  // shortcut: resolution is checked here and fetch resolves again (TOCTOU); upgrade to a pinned-connect dispatcher if a dependency is accepted.
  const addrs = await lookup(API_HOST, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new SkillpilotError("SOURCE_UNAVAILABLE", "api.github.com resolved to a non-public address.", "Check DNS or proxy configuration.");
  }
  const res = await fetch(url, {
    redirect: "manual",
    signal,
    headers: { Accept: "application/vnd.github+json", "User-Agent": "skillpilot", "X-GitHub-Api-Version": "2022-11-28" },
  });
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    for await (const chunk of res.body) {
      total += chunk.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new SkillpilotError("SOURCE_UNAVAILABLE", "GitHub response exceeded the size cap.", "The source is too large for MVP limits.");
      }
      chunks.push(chunk);
    }
  }
  return { status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.concat(chunks) };
};

const RepoSchema = z.object({
  full_name: z.string(),
  private: z.boolean(),
  default_branch: z.string().min(1).max(255),
  license: z.object({ spdx_id: z.string().nullable() }).nullable().optional(),
});
const BranchSchema = z.object({ commit: z.object({ sha: z.string().regex(COMMIT_ID) }) });
const TreeSchema = z.object({
  sha: z.string(),
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: z.string(), size: z.number().int().nonnegative().optional() })).max(100_000),
});
const BlobSchema = z.object({ sha: z.string(), size: z.number().int().nonnegative(), encoding: z.literal("base64"), content: z.string() });

export type TreeEntry = z.infer<typeof TreeSchema>["tree"][number];

export interface ClientOptions {
  offline?: boolean;
  deadlineMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRequest?: (summary: string) => void;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Minimal read-only GitHub REST client for public repositories. */
export class GitHubClient {
  private readonly deadline: number;
  readonly requests: string[] = [];
  private readonly transport: Transport;
  private readonly opts: ClientOptions;

  constructor(transport: Transport, opts: ClientOptions = {}) {
    this.transport = transport;
    this.opts = opts;
    this.deadline = Date.now() + (opts.deadlineMs ?? COMMAND_DEADLINE_MS);
  }

  private async getJson(path: string): Promise<unknown> {
    if (this.opts.offline) {
      throw new SkillpilotError("SOURCE_UNAVAILABLE", "Network access is disabled by --offline.", "Rerun without --offline to fetch sources.");
    }
    const url = new URL(`https://${API_HOST}${path}`);
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      const remaining = this.deadline - Date.now();
      if (remaining <= 0) throw new SkillpilotError("SOURCE_UNAVAILABLE", "GitHub request deadline exceeded.", "Retry later or use cached sources.");
      this.requests.push(`GET ${url.pathname}${url.search}`);
      this.opts.onRequest?.(`GET ${url.pathname}`);
      let res: HttpResponse;
      try {
        res = await this.transport(url, AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)));
      } catch (err) {
        if (err instanceof SkillpilotError) throw err;
        if (attempt < MAX_RETRIES) { await sleep(500 * 2 ** attempt); continue; }
        throw new SkillpilotError("SOURCE_UNAVAILABLE", "GitHub could not be reached.", "Check the network connection or use --offline with cached sources.");
      }
      if (res.status >= 300 && res.status < 400) {
        throw new SkillpilotError("SOURCE_UNAVAILABLE", "GitHub redirected the request; the repository may have moved or been renamed.", "Look up the canonical repository and request it explicitly.");
      }
      if ((res.status === 403 || res.status === 429) && (res.headers["x-ratelimit-remaining"] === "0" || res.status === 429)) {
        const reset = Number(res.headers["x-ratelimit-reset"]) * 1000;
        const wait = Number.isFinite(reset) ? reset - Date.now() : Infinity;
        if (attempt < MAX_RETRIES && wait > 0 && wait < this.deadline - Date.now() && wait < 30_000) { await sleep(wait); continue; }
        throw new SkillpilotError("RATE_LIMITED", "GitHub's unauthenticated rate limit was reached.", "Retry after the limit resets, or use --offline with cached data.", Number.isFinite(reset) ? { resetsAt: new Date(reset).toISOString() } : undefined);
      }
      if (res.status >= 500 && attempt < MAX_RETRIES) { await sleep(500 * 2 ** attempt); continue; }
      if (res.status === 404) throw new SkillpilotError("SOURCE_UNAVAILABLE", "Repository or object not found (private sources are unsupported).", "Check the owner/repository and path.");
      if (res.status !== 200) throw new SkillpilotError("SOURCE_UNAVAILABLE", `GitHub returned HTTP ${res.status}.`, "Retry later.");
      try {
        return JSON.parse(Buffer.from(res.body).toString("utf8"));
      } catch {
        throw new SkillpilotError("SOURCE_UNAVAILABLE", "GitHub returned malformed JSON.", "Retry later.");
      }
    }
  }

  private parse<T>(schema: z.ZodType<T>, json: unknown, what: string): T {
    const r = schema.safeParse(json);
    if (!r.success) throw new SkillpilotError("SOURCE_UNAVAILABLE", `Unexpected GitHub ${what} response.`, "Retry later; the response failed validation.");
    return r.data;
  }

  async getRepository(owner: string, repo: string) {
    if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) throw new SkillpilotError("INVALID_ARGUMENT", "Invalid repository identifier.", "Use owner/repository.");
    const r = this.parse(RepoSchema, await this.getJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`), "repository");
    if (r.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
      throw new SkillpilotError("SOURCE_UNAVAILABLE", `Repository resolves to ${r.full_name}, a different identity.`, `Request ${r.full_name} explicitly if you trust it.`, { canonical: r.full_name });
    }
    if (r.private) throw new SkillpilotError("SOURCE_UNAVAILABLE", "Private repositories are unsupported.", "Use a public repository.");
    return { defaultBranch: r.default_branch, licenseSpdx: r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : null };
  }

  async resolveBranch(owner: string, repo: string, branch: string): Promise<string> {
    const b = this.parse(BranchSchema, await this.getJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`), "branch");
    return b.commit.sha;
  }

  /** Recursive tree at an exact commit. Fails closed on truncation. */
  async getTree(owner: string, repo: string, commit: string): Promise<TreeEntry[]> {
    if (!COMMIT_ID.test(commit)) throw new SkillpilotError("INVALID_ARGUMENT", "Invalid commit ID.", "Use a full 40-character commit ID.");
    const t = this.parse(TreeSchema, await this.getJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${commit}?recursive=1`), "tree");
    if (t.truncated) throw new SkillpilotError("SOURCE_UNAVAILABLE", "GitHub returned a truncated repository tree.", "The repository is too large for MVP discovery; reference a catalog entry instead.");
    return t.tree;
  }

  /** Fetches a blob, enforces the size cap, and verifies the Git object hash of the decoded bytes. */
  async getBlob(owner: string, repo: string, sha: string, maxBytes: number): Promise<Buffer> {
    if (!COMMIT_ID.test(sha)) throw new SkillpilotError("SOURCE_UNAVAILABLE", "Invalid blob ID.", "Retry later.");
    const b = this.parse(BlobSchema, await this.getJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${sha}`), "blob");
    if (b.size > maxBytes) throw new SkillpilotError("SOURCE_UNAVAILABLE", "Blob exceeds the size cap.", "The file is too large for MVP limits.");
    const bytes = Buffer.from(b.content.replace(/\n/g, ""), "base64");
    const gitSha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (bytes.length !== b.size || gitSha !== sha) throw new SkillpilotError("SOURCE_UNAVAILABLE", "Blob content did not match its object ID.", "Retry later; the response may be corrupted.");
    return bytes;
  }
}
