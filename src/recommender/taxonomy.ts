// Scoring taxonomy for fit-v1. Changing anything here requires a new scoring version and benchmark report.
export const SCORING_VERSION = "fit-v1";

export const GOAL_TAGS = [
  "accessibility", "ai-integration", "browser-testing", "build-tooling", "cloud-workers", "code-review", "concurrency",
  "data-analysis", "data-fetching", "database", "datasets", "debugging", "demo-ui", "deployment", "kotlin-migration",
  "mcp", "ml-training", "navigation", "performance", "property-testing", "python-tooling", "security", "testing",
  "ui-design", "upgrade",
] as const;
export type GoalTag = (typeof GOAL_TAGS)[number];

/** Explicit phrase → tag mappings over normalized word sequences. No substring guessing. */
const GOAL_SYNONYMS: Record<GoalTag, string[]> = {
  accessibility: ["accessibility", "a11y", "accessible", "wcag", "screen reader", "voiceover", "talkback"],
  "ai-integration": ["ai", "llm", "llms", "agent", "agents", "chatbot", "claude", "openai", "gpt", "ai features", "rag"],
  "browser-testing": ["e2e", "end to end", "browser test", "browser tests", "browser testing", "playwright", "cypress", "ui tests"],
  "build-tooling": ["gradle", "build system", "build performance", "build times", "agp", "android gradle plugin"],
  "cloud-workers": ["cloudflare", "workers", "wrangler", "edge functions"],
  "code-review": ["code review", "review code", "pr review", "pull request review", "review my code"],
  concurrency: ["concurrency", "async await", "actors", "data race", "data races", "sendable", "threading"],
  "data-analysis": ["data analysis", "analyze data", "analyse data", "notebook", "notebooks", "visualization", "exploratory"],
  "data-fetching": ["data fetching", "fetch data", "api calls", "network requests", "caching", "offline", "sync", "react query"],
  database: ["database", "postgres", "postgresql", "sql", "schema design", "supabase", "rls", "jpa", "hibernate", "orm"],
  datasets: ["dataset", "datasets", "data loading"],
  debugging: ["debug", "debugging", "bug", "bugs", "crash", "crashes", "failing test", "failing tests", "troubleshoot"],
  "demo-ui": ["gradio", "demo", "demos", "prototype ui"],
  deployment: ["deploy", "deployment", "ship", "release", "hosting", "app store", "testflight", "play store", "publish app"],
  "kotlin-migration": ["java to kotlin", "convert java", "j2k", "migrate java"],
  mcp: ["mcp", "model context protocol", "mcp server"],
  "ml-training": ["train", "training", "fine tune", "finetune", "fine tuning", "lora", "model training"],
  navigation: ["navigation", "routing", "router", "routes", "deep link", "deep links", "tabs"],
  performance: ["performance", "perf", "slow", "speed up", "optimize", "optimise", "jank", "web vitals", "core web vitals", "lighthouse", "frame drops", "lag"],
  "property-testing": ["property based", "property testing", "fuzz", "fuzzing", "hypothesis", "fast check"],
  "python-tooling": ["uv", "ruff", "python tooling", "python packaging", "project setup", "pyproject"],
  security: ["security", "secure", "vulnerability", "vulnerabilities", "owasp", "security review", "security audit"],
  testing: ["test", "tests", "testing", "unit test", "unit tests", "tdd", "test coverage", "coverage"],
  "ui-design": ["redesign", "ui design", "ui", "ux", "styling", "visual design", "layout", "theme", "theming", "interface", "screens"],
  upgrade: ["upgrade", "upgrading", "migrate", "migration", "bump version", "new sdk", "sdk upgrade"],
};

/** Child → generic parents. A generic candidate tag matches a more specific project token. */
export const STACK_PARENTS: Record<string, string[]> = {
  nextjs: ["react"], react: ["web"], vite: ["web"], vue: ["web"], svelte: ["web"], angular: ["web"], tailwind: ["web"],
  expo: ["react-native"], "react-native": ["mobile"], ios: ["mobile"], android: ["mobile"], swift: [],
  typescript: ["javascript"], node: ["javascript"], "vercel-ai-sdk": ["ai"], langchain: ["ai"], mcp: ["ai"],
  "data-science": ["python"], ml: ["python"], jupyter: ["data-science"],
  playwright: ["testing"], vitest: ["testing"], jest: ["testing"], cypress: ["testing"],
  kotlin: ["jvm"], java: ["jvm"], gradle: ["jvm"], prisma: ["database"],
};

/**
 * Project tokens that count toward stack fit. Tooling-only tokens (docker, ci, vercel, …) and the near-universal
 * javascript/typescript language tokens do not dilute it; no catalog entry targets them specifically.
 */
export const APPLICABLE_STACK = new Set(
  [...Object.keys(STACK_PARENTS), ...Object.values(STACK_PARENTS).flat(), "swift", "python", "cloudflare", "database", "ai", "backend"]
    .filter((t) => t !== "javascript" && t !== "typescript"),
);

/** Tokens made redundant by a more specific one, without implying a match (React Native apps are not React web apps). */
const IMPLIED: Record<string, string[]> = { "react-native": ["react"] };

export function ancestors(token: string): Set<string> {
  const out = new Set<string>();
  const stack = [...(STACK_PARENTS[token] ?? [])];
  while (stack.length) {
    const t = stack.pop()!;
    if (!out.has(t)) {
      out.add(t);
      stack.push(...(STACK_PARENTS[t] ?? []));
    }
  }
  return out;
}

/** Most specific project tokens: drop any token that is an ancestor of another project token. */
export function leafTokens(tokens: string[]): string[] {
  const covered = new Set(tokens.flatMap((t) => [...ancestors(t), ...[t, ...ancestors(t)].flatMap((a) => IMPLIED[a] ?? [])]));
  return [...new Set(tokens)].filter((t) => !covered.has(t)).sort();
}

/** True when a candidate stack tag applies to a project token (same token or a generic ancestor). */
export const stackMatches = (candidateTag: string, projectToken: string) =>
  candidateTag === projectToken || ancestors(projectToken).has(candidateTag);

export function normalizeWords(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

const PHRASES: [string[], GoalTag][] = Object.entries(GOAL_SYNONYMS)
  .flatMap(([tag, phrases]) => phrases.map((p) => [p.split(" "), tag as GoalTag] as [string[], GoalTag]))
  .sort((a, b) => b[0].length - a[0].length);

/** Maps free text to goal taxonomy tags by greedy longest whole-word phrase matches. */
export function goalTags(text: string): GoalTag[] {
  const words = normalizeWords(text);
  const found = new Set<GoalTag>();
  for (let i = 0; i < words.length; ) {
    const hit = PHRASES.find(([phrase]) => phrase.every((w, j) => words[i + j] === w));
    if (hit) {
      found.add(hit[1]);
      i += hit[0].length;
    } else i++;
  }
  return [...found].sort();
}
