import { parse as parseToml } from "smol-toml";
import { parseStrictYaml } from "../schemas/manifest.ts";

export type Confidence = "high" | "medium" | "low";

export interface Evidence {
  path: string;
  key: string;
  token: string;
  confidence: Confidence;
  origin: "detected" | "user-declared";
}

type Tokens = readonly string[];

// Dependency key → stack tokens. Keys are matched exactly; never by substring.
const JS_DEPS: Record<string, Tokens> = {
  next: ["nextjs", "react", "web"],
  react: ["react"],
  "react-dom": ["react", "web"],
  vite: ["vite", "web"],
  vue: ["vue", "web"],
  svelte: ["svelte", "web"],
  "@sveltejs/kit": ["svelte", "web"],
  "@angular/core": ["angular", "web"],
  "react-native": ["react-native", "mobile"],
  expo: ["expo", "react-native", "mobile"],
  typescript: ["typescript"],
  express: ["node", "backend"],
  fastify: ["node", "backend"],
  koa: ["node", "backend"],
  hono: ["node", "backend"],
  "@nestjs/core": ["node", "backend"],
  "@playwright/test": ["playwright", "testing"],
  playwright: ["playwright", "testing"],
  cypress: ["cypress", "testing"],
  vitest: ["vitest", "testing"],
  jest: ["jest", "testing"],
  tailwindcss: ["tailwind"],
  prisma: ["prisma", "database"],
  "@prisma/client": ["prisma", "database"],
  "drizzle-orm": ["database"],
  openai: ["ai"],
  "@anthropic-ai/sdk": ["ai"],
  ai: ["ai", "vercel-ai-sdk"],
  langchain: ["ai", "langchain"],
  llamaindex: ["ai"],
  "@modelcontextprotocol/sdk": ["ai", "mcp"],
  "@google/genai": ["ai"],
  "@google/generative-ai": ["ai"],
};
const JS_DEP_PREFIXES: [string, Tokens][] = [
  ["@ai-sdk/", ["ai", "vercel-ai-sdk"]],
  ["@langchain/", ["ai", "langchain"]],
];

const PY_DEPS: Record<string, Tokens> = {
  pandas: ["data-science"], numpy: ["data-science"], scipy: ["data-science"], polars: ["data-science"],
  matplotlib: ["data-science"], seaborn: ["data-science"], plotly: ["data-science"], statsmodels: ["data-science"],
  jupyter: ["data-science", "jupyter"], jupyterlab: ["data-science", "jupyter"], notebook: ["data-science", "jupyter"], ipykernel: ["data-science", "jupyter"],
  "scikit-learn": ["ml"], sklearn: ["ml"], torch: ["ml"], tensorflow: ["ml"], keras: ["ml"], xgboost: ["ml"],
  lightgbm: ["ml"], jax: ["ml"], transformers: ["ml"], "pytorch-lightning": ["ml"],
  openai: ["ai"], anthropic: ["ai"], langchain: ["ai", "langchain"], "langchain-core": ["ai", "langchain"],
  "llama-index": ["ai"], litellm: ["ai"], "google-genai": ["ai"], mcp: ["ai", "mcp"],
  fastapi: ["backend"], flask: ["backend"], django: ["backend"],
  pytest: ["testing"],
};

/** Config files whose mere existence is tooling evidence (never evaluated). */
const EXISTENCE: [RegExp, Tokens, Confidence][] = [
  [/^tsconfig(\..+)?\.json$/, ["typescript"], "high"],
  [/^next\.config\.(js|mjs|cjs|ts)$/, ["nextjs"], "medium"],
  [/^vite\.config\.(js|mjs|cjs|ts|mts)$/, ["vite", "web"], "medium"],
  [/^playwright\.config\.(js|mjs|cjs|ts)$/, ["playwright", "testing"], "medium"],
  [/^vitest\.config\.(js|mjs|cjs|ts|mts)$/, ["vitest", "testing"], "medium"],
  [/^jest\.config\.(js|mjs|cjs|ts|json)$/, ["jest", "testing"], "medium"],
  [/^cypress\.config\.(js|mjs|cjs|ts)$/, ["cypress", "testing"], "medium"],
  [/^(Dockerfile|Containerfile|(docker-)?compose\.ya?ml)$/, ["docker"], "medium"],
  [/^vercel\.json$/, ["vercel"], "medium"],
  [/^netlify\.toml$/, ["netlify"], "medium"],
  [/^setup\.(py|cfg)$/, ["python"], "medium"],
  [/^AndroidManifest\.xml$/, ["android"], "medium"],
  [/^Info\.plist$/, ["ios"], "low"],
  [/\.ipynb$/, ["data-science", "jupyter"], "medium"],
  [/\.swift$/, ["swift"], "low"],
  [/\.kts?$/, ["kotlin"], "low"],
  [/\.java$/, ["java"], "low"],
  [/\.py$/, ["python"], "low"],
  [/\.tsx?$/, ["typescript"], "low"],
];

/** Files whose contents are parsed as data (or matched with bounded literals). */
export function isParsedFile(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  return (
    base === "package.json" || base === "app.json" || base === "pyproject.toml" || base === "Pipfile" ||
    /^requirements([-_.][\w.-]+)?\.txt$/.test(base) || /^environment\.ya?ml$/.test(base) ||
    base === "Package.swift" || /^(settings|build)\.gradle(\.kts)?$/.test(base) || rel.endsWith(".xcodeproj/project.pbxproj")
  );
}

export interface FileDetection {
  evidence: Evidence[];
  workspaces?: boolean;
  problem?: string;
}

const ev = (path: string, key: string, tokens: Tokens, confidence: Confidence): Evidence[] =>
  tokens.map((token) => ({ path, key, token, confidence, origin: "detected" as const }));

export function detectFromName(rel: string): Evidence[] {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const out: Evidence[] = [];
  if (rel.startsWith(".github/workflows/") && /\.ya?ml$/.test(base)) out.push(...ev(rel, "file", ["ci"], "medium"));
  if (rel.endsWith(".xcodeproj/project.pbxproj")) out.push(...ev(rel, "file", ["xcode"], "high"));
  for (const [re, tokens, conf] of EXISTENCE) if (re.test(base)) out.push(...ev(rel, "file", tokens, conf));
  return out;
}

/** PEP 503-style normalization of the leading distribution name in a requirement string. */
export function pyName(spec: string): string | null {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
  return m ? m[1]!.toLowerCase().replace(/[-_.]+/g, "-") : null;
}

function pyDeps(rel: string, key: string, names: Iterable<string>): Evidence[] {
  const out = ev(rel, key, ["python"], "high");
  for (const raw of names) {
    const name = pyName(raw);
    const tokens = name ? PY_DEPS[name] : undefined;
    if (tokens) out.push(...ev(rel, `${key}:${name}`, tokens, "high"));
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keysOf = (v: unknown) => (isRecord(v) ? Object.keys(v) : []);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Detects stack evidence from a parsed file's text. Never evaluates code. */
export function detectFromContent(rel: string, text: string): FileDetection {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  try {
    if (base === "package.json") {
      const pkg: unknown = JSON.parse(text);
      if (!isRecord(pkg)) return { evidence: [], problem: "not a JSON object" };
      const out = ev(rel, "manifest", ["javascript"], "high");
      const deps = new Set(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((k) => keysOf(pkg[k])));
      for (const dep of [...deps].sort()) {
        const tokens = JS_DEPS[dep] ?? JS_DEP_PREFIXES.find(([p]) => dep.startsWith(p))?.[1];
        if (tokens) out.push(...ev(rel, `dependency:${dep}`, tokens, "high"));
      }
      return { evidence: out, workspaces: pkg.workspaces !== undefined };
    }
    if (base === "app.json") {
      const app: unknown = JSON.parse(text);
      return { evidence: isRecord(app) && isRecord(app.expo) ? ev(rel, "key:expo", ["expo", "react-native", "mobile"], "high") : [] };
    }
    if (base === "pyproject.toml" || base === "Pipfile") {
      const t = parseToml(text) as Record<string, unknown>;
      const names: string[] = [];
      if (base === "Pipfile") names.push(...keysOf(t.packages), ...keysOf(t["dev-packages"]));
      else {
        const project = isRecord(t.project) ? t.project : {};
        names.push(...strings(project.dependencies));
        if (isRecord(project["optional-dependencies"])) for (const v of Object.values(project["optional-dependencies"])) names.push(...strings(v));
        if (isRecord(t["dependency-groups"])) for (const v of Object.values(t["dependency-groups"])) names.push(...strings(v));
        const poetry = isRecord(t.tool) && isRecord(t.tool.poetry) ? t.tool.poetry : {};
        names.push(...keysOf(poetry.dependencies).filter((n) => n !== "python"));
        if (isRecord(poetry.group)) for (const g of Object.values(poetry.group)) if (isRecord(g)) names.push(...keysOf(g.dependencies));
      }
      return { evidence: pyDeps(rel, "dependency", names) };
    }
    if (/^requirements/.test(base)) {
      const names = text.split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter((l) => l && !l.startsWith("-"));
      return { evidence: pyDeps(rel, "requirement", names) };
    }
    if (/^environment\.ya?ml$/.test(base)) {
      const parsed = parseStrictYaml(text);
      if (!parsed.ok) return { evidence: [], problem: parsed.problems[0] ?? "invalid YAML" };
      const deps = isRecord(parsed.value) && Array.isArray(parsed.value.dependencies) ? parsed.value.dependencies : [];
      const names = deps.flatMap((d: unknown) => (typeof d === "string" ? [d] : isRecord(d) ? strings(d.pip) : []));
      return { evidence: pyDeps(rel, "conda", names) };
    }
    if (base === "Package.swift") {
      const out = ev(rel, "manifest", ["swift"], "high");
      if (/\.iOS\s*\(/.test(text)) out.push(...ev(rel, "literal:.iOS(", ["ios"], "medium"));
      return { evidence: out };
    }
    if (rel.endsWith(".xcodeproj/project.pbxproj")) {
      const ios = /SDKROOT = iphoneos|IPHONEOS_DEPLOYMENT_TARGET/.test(text);
      return { evidence: ios ? ev(rel, "literal:iphoneos", ["ios"], "high") : [] };
    }
    if (/\.gradle(\.kts)?$/.test(base)) {
      const out = ev(rel, "file", ["gradle"], "high");
      if (/com\.android\.(application|library|tools\.build)/.test(text)) out.push(...ev(rel, "literal:com.android", ["android"], "high"));
      if (/org\.jetbrains\.kotlin|kotlin\s*\(\s*"/.test(text)) out.push(...ev(rel, "literal:kotlin-plugin", ["kotlin"], "medium"));
      return { evidence: out };
    }
  } catch {
    return { evidence: [], problem: "could not be parsed as data" };
  }
  return { evidence: [] };
}
