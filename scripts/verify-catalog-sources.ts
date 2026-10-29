// Explicit, network-dependent catalog maintenance check: every pinned catalog entry must still be a public
// repository with the same identity whose pinned commit contains <skillPath>/SKILL.md. About two GitHub
// requests per repository. Never part of ordinary test runs.
import { fetchTransport, GitHubClient } from "../src/fetcher/github.ts";
import { loadBundledCatalog } from "../src/sources/catalog.ts";
import { toErrorObject } from "../src/errors.ts";

const catalog = loadBundledCatalog();
const client = new GitHubClient(fetchTransport, { deadlineMs: 300_000 });
const byRepoCommit = new Map<string, typeof catalog.entries>();
for (const e of catalog.entries) {
  const key = `${e.source.owner}/${e.source.repository}@${e.source.commit}`;
  byRepoCommit.set(key, [...(byRepoCommit.get(key) ?? []), e]);
}
let failed = 0;
for (const [key, entries] of [...byRepoCommit].sort()) {
  const { owner, repository, commit } = entries[0]!.source;
  try {
    await client.getRepository(owner, repository);
    const paths = new Set((await client.getTree(owner, repository, commit)).filter((t) => t.type === "blob").map((t) => t.path));
    for (const e of entries) {
      const skillMd = e.source.skillPath === "." ? "SKILL.md" : `${e.source.skillPath}/SKILL.md`;
      const ok = paths.has(skillMd);
      if (!ok) failed++;
      console.log(`${ok ? "PASS" : "FAIL"} ${e.id} @ ${commit.slice(0, 12)}${ok ? "" : ` (${skillMd} not found at the pinned commit)`}`);
    }
  } catch (err) {
    failed += entries.length;
    const e = toErrorObject(err);
    console.log(`FAIL ${key}: ${e.code} ${e.message}`);
  }
}
console.log(`\n${catalog.entries.length - failed}/${catalog.entries.length} catalog entries verified against GitHub on ${new Date().toISOString().slice(0, 10)} (catalog ${catalog.catalogVersion}).`);
process.exit(failed ? 1 : 0);
