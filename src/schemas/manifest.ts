import { isAlias, isNode, parseDocument, visit } from "yaml";
import { z } from "zod";

// Agent Skills spec: lowercase a-z/0-9, single hyphens, no leading/trailing hyphen, 1-64 chars.
export const SKILL_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const ManifestSchema = z
  .object({
    name: z.string().regex(SKILL_NAME),
    description: z.string().trim().min(1).max(1024),
    license: z.string().min(1).max(200).optional(),
    compatibility: z.string().min(1).max(500).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    "allowed-tools": z.string().optional(),
  })
  .passthrough();

export type Manifest = z.infer<typeof ManifestSchema>;

export type ManifestResult = { ok: true; manifest: Manifest; extraKeys: string[] } | { ok: false; problems: string[] };

const PORTABLE_KEYS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);

/** Strict YAML parse: duplicate keys, aliases, and explicit tags are rejected rather than repaired. */
export function parseStrictYaml(text: string): { ok: true; value: unknown } | { ok: false; problems: string[] } {
  const doc = parseDocument(text, { uniqueKeys: true, schema: "core", prettyErrors: false });
  const problems = doc.errors.map((e) => e.message);
  visit(doc, (_key, node) => {
    if (isAlias(node)) problems.push("YAML aliases are not allowed.");
    else if (isNode(node) && node.tag) problems.push(`YAML tag ${node.tag} is not allowed.`);
  });
  if (problems.length) return { ok: false, problems };
  return { ok: true, value: doc.toJS({ maxAliasCount: 0 }) };
}

/** Extracts and validates SKILL.md frontmatter. Never repairs invalid metadata. */
export function parseSkillManifest(content: string): ManifestResult {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return { ok: false, problems: ["SKILL.md has no YAML frontmatter block."] };
  const yaml = parseStrictYaml(match[1]!);
  if (!yaml.ok) return yaml;
  const parsed = ManifestSchema.safeParse(yaml.value);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "frontmatter"}: ${i.message}`) };
  }
  const extraKeys = Object.keys(parsed.data).filter((k) => !PORTABLE_KEYS.has(k)).sort();
  return { ok: true, manifest: parsed.data, extraKeys };
}
