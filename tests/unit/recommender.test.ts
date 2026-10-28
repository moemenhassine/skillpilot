import { describe, expect, it } from "vitest";
import { recommend, type Candidate } from "../../src/recommender/index.ts";
import { goalTags, leafTokens, stackMatches, type GoalTag } from "../../src/recommender/taxonomy.ts";

function cand(id: string, over: Partial<Candidate> = {}): Candidate {
  return {
    id: `acme/skills#skills/${id}`, name: id, description: `${id} skill`,
    source: { provider: "github", owner: "acme", repository: "skills", skillPath: `skills/${id}`, commit: "a".repeat(40) },
    categories: ["web"], stack: [], requiresAnyStack: [], tasks: ["testing"], prerequisites: [],
    agents: { "claude-code": "portable", codex: "portable" },
    license: { spdx: "MIT", scope: "repository", evidencePath: "LICENSE" },
    payload: { files: 1, bytes: 10, unsupportedFiles: [] }, targetSpecificFrontmatter: [], verifiedAt: "2026-10-28",
    annotationOrigin: "curated", discoveredVia: ["bundled"], ...over,
  };
}
const run = (candidates: Candidate[], stack: string[], goals: GoalTag[], extra: Partial<Parameters<typeof recommend>[0]> = {}) =>
  recommend({ candidates, stack, goalTags: goals, agents: ["claude-code", "codex"], limit: 5, ...extra });

describe("taxonomy", () => {
  it("maps synonyms by whole words with longest-phrase precedence", () => {
    expect(goalTags("Improve a11y and add e2e tests")).toEqual(["accessibility", "browser-testing", "testing"]);
    expect(goalTags("add browser tests")).toEqual(["browser-testing"]);
    expect(goalTags("Build an offline habit tracker")).toEqual(["data-fetching"]);
    expect(goalTags("schema design for postgres")).toEqual(["database"]);
    expect(goalTags("contest latest")).toEqual([]); // no substring matches ("test")
  });
  it("collapses ancestors and implied tokens to leaves", () => {
    expect(leafTokens(["nextjs", "react", "web", "playwright", "testing"])).toEqual(["nextjs", "playwright"]);
    expect(leafTokens(["expo", "react-native", "react", "mobile"])).toEqual(["expo"]);
  });
  it("lets generic candidate tags match specific project tokens, not the reverse", () => {
    expect(stackMatches("web", "nextjs")).toBe(true);
    expect(stackMatches("nextjs", "web")).toBe(false);
    expect(stackMatches("web", "expo")).toBe(false);
  });
});

describe("fit-v1 components", () => {
  it("computes each component exactly", () => {
    const r = run([cand("x", { stack: ["nextjs"], tasks: ["browser-testing", "testing"] })], ["nextjs", "react", "playwright"], ["browser-testing", "accessibility", "testing"]);
    const s = r.recommendations[0]!.score;
    // leaves: nextjs, playwright → 1/2 matched → 20; goals 2/3 → round(23.33)=23; portable 8; metadata 10
    expect(s).toEqual({ stackFit: 20, goalFit: 23, compatibility: 8, metadataCompleteness: 10, base: 61, redundancyPenalty: 0, final: 61 });
    expect(r.applicableStack).toEqual(["nextjs", "playwright"]);
  });
  it("scores compatibility by the weaker target and treats target-specific frontmatter as unknown", () => {
    const verifiedClaude = cand("v", { tasks: ["testing"], agents: { "claude-code": "verified", codex: "portable" } });
    expect(run([verifiedClaude], [], ["testing"]).recommendations[0]!.score.compatibility).toBe(8);
    expect(run([verifiedClaude], [], ["testing"], { agents: ["claude-code"] }).recommendations[0]!.score.compatibility).toBe(15);
    const specific = cand("s", { targetSpecificFrontmatter: ["effort"] });
    const r = run([specific], [], ["testing"]);
    expect(r.recommendations[0]!.score.compatibility).toBe(0);
    expect(r.recommendations[0]!.limitations.join(" ")).toMatch(/target-specific frontmatter/);
  });
  it("measures metadata completeness, not safety", () => {
    const r = run([cand("m", { license: { spdx: null, scope: "repository", evidencePath: "x" }, prerequisites: null })], [], ["testing"]);
    expect(r.recommendations[0]!.score.metadataCompleteness).toBe(6);
  });
  it("does not reward repeated tags", () => {
    const a = run([cand("a", { stack: ["web", "web", "web"] })], ["nextjs", "vue"], ["testing"]).recommendations[0]!;
    expect(a.score.stackFit).toBe(40);
    expect(a.matchedStack).toHaveLength(2);
  });
});

describe("eligibility", () => {
  it("drops candidates with no stack or goal match and those below 35", () => {
    const r = run([cand("none", { tasks: ["security"] }), cand("weak", { stack: ["web"], tasks: ["security"] })], ["nextjs", "python", "ios", "android", "kotlin"], ["testing"], { limit: 5 });
    expect(r.recommendations).toEqual([]);
    expect(r.exclusions).toEqual([
      { id: "acme/skills#skills/none", reason: "no stack or goal match" },
      { id: "acme/skills#skills/weak", reason: "fit score below 35", base: 26 },
    ]);
  });
  it("applies curated required stacks only when the project stack is known", () => {
    const c = cand("rn", { stack: ["react-native"], requiresAnyStack: ["react-native"], tasks: ["upgrade"] });
    expect(run([c], ["android", "kotlin"], ["upgrade"]).exclusions[0]!.reason).toBe("requires one of: react-native");
    expect(run([c], ["expo"], ["upgrade"]).recommendations).toHaveLength(1);
    expect(run([c], [], ["upgrade"]).recommendations).toHaveLength(1);
  });
  it("excludes explicit agent exclusions, config exclusions, and exact managed installs", () => {
    const r = run([
      cand("ex", { agents: { "claude-code": "portable", codex: "excluded" } }),
      cand("cfg"),
      cand("inst"),
    ], [], ["testing"], { excludeIds: new Set(["acme/skills#skills/cfg"]), installedExact: new Set([`acme/skills#skills/inst@${"a".repeat(40)}`]) });
    expect(r.recommendations).toEqual([]);
    expect(r.exclusions.map((x) => x.reason)).toEqual(["excluded by project configuration", "explicitly excludes codex", "exact payload already installed and managed"]);
  });
  it("returns a valid empty result with notes when nothing is supplied", () => {
    const r = run([cand("a")], [], []);
    expect(r.recommendations).toEqual([]);
    expect(r.notes).toHaveLength(2);
  });
});

describe("ordering and diversity", () => {
  it("penalizes a redundant same-primary-task candidate once and re-sorts", () => {
    const r = run([
      cand("a1", { stack: ["web"], tasks: ["testing"] }),
      cand("a2", { stack: ["web"], tasks: ["testing"] }),
      cand("b", { stack: ["web"], tasks: ["testing", "debugging"] }),
    ], ["nextjs"], ["testing", "debugging"]);
    expect(r.recommendations.map((x) => [x.name, x.score.final, x.score.redundancyPenalty])).toEqual([
      ["b", 93, 0], ["a1", 76, 0], ["a2", 61, 15],
    ]);
  });
  it("breaks ties by base score then source ID and is deterministic regardless of input order", () => {
    const cs = ["zeta", "alpha", "mid"].map((n) => cand(n, { stack: ["web"], tasks: [n === "alpha" ? "testing" : "debugging"] }));
    const a = run(cs, ["nextjs"], ["testing", "debugging"]);
    const b = run([...cs].reverse(), ["nextjs"], ["testing", "debugging"]);
    expect(a).toEqual(b);
    expect(a.recommendations.map((x) => x.name)).toEqual(["alpha", "mid", "zeta"]);
  });
  it("honours the limit and reports the rest", () => {
    const r = run(["a", "b", "c"].map((n) => cand(n, { tasks: [n === "a" ? "testing" : n === "b" ? "debugging" : "security"] })), [], ["testing", "debugging", "security"], { limit: 1 });
    expect(r.recommendations).toHaveLength(0); // each matches 1/3 goals → 12+8+10 = 30 < 35
    const r2 = run(["a", "b"].map((n) => cand(n)), [], ["testing"], { limit: 1 });
    expect(r2.recommendations.map((x) => x.name)).toEqual(["a"]);
    expect(r2.exclusions).toEqual([{ id: "acme/skills#skills/b", reason: "outside limit of 1", base: 53 }]);
  });
});
