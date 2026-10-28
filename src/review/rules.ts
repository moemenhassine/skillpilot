import { sha256Hex } from "../storage/canonical.ts";

export const RULE_SET_VERSION = "rules-v1";

export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type Confidence = "high" | "medium" | "low";

export interface Finding {
  id: string;
  ruleId: string;
  severity: Severity;
  confidence: Confidence;
  file: string;
  lineStart?: number;
  lineEnd?: number;
  occurrences: number;
  explanation: string;
  remediation: string;
  blocking: boolean;
  context?: string;
}

/** Stable instance ID from rule, file, location, and a hash of the matched text (never the text itself). */
export function findingId(ruleId: string, file: string, line: number | undefined, matched: string): string {
  return `F-${sha256Hex(`${ruleId}\0${file}\0${line ?? 0}\0${sha256Hex(matched)}`).slice(0, 16)}`;
}

interface TextRule {
  ruleId: string;
  severity: Severity;
  confidence: Confidence;
  pattern: RegExp;
  explanation: string;
  remediation: string;
  /** Restrict to code files, prose files, or SKILL.md. */
  scope?: "code" | "prose" | "skill-md";
  /** Secret-like matches are never echoed and are not softened by context. */
  secret?: boolean;
}

const CODE_EXT = /\.(py|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|ps1)$/i;

/** Versioned text rules (spec 11.2). Each has positive and negative fixtures in tests/unit/rules.test.ts. */
export const TEXT_RULES: TextRule[] = [
  { ruleId: "INJ-001", severity: "high", confidence: "medium",
    pattern: /\b(ignore|disregard|override)\s+(all\s+)?(of\s+)?(the\s+)?(previous|prior|above|earlier|system|higher[- ]priority|developer)\s+(instructions|directions|rules|prompts?|messages?)\b|\b(do\s+not|don't|never)\s+(tell|inform|show|mention\s+(this\s+)?to)\s+the\s+user\b|\bwithout\s+(telling|informing|notifying|asking)\s+the\s+user\b|\bthe\s+user\s+(has\s+)?(already\s+)?(approved|authori[sz]ed|consented)\b|\bhide\s+(this|these|the)\s+(action|step|change|command)s?\s+from\b/i,
    explanation: "Instructs the agent to override higher-priority directions, hide actions, or assume approval.",
    remediation: "Remove instructions that subvert the user's or host's control." },
  { ruleId: "SEC-001", severity: "critical", confidence: "medium",
    pattern: /\b(cat|read|copy|cp|upload|send|post|exfiltrat\w*|collect|grab|base64)\b[^\n]{0,60}(~\/\.ssh|\bid_(rsa|ed25519|ecdsa)\b|\.aws\/credentials|~\/\.netrc|~\/\.npmrc|~\/\.docker\/config\.json|\bkeychain\b|login\.keychain|security\s+find-(generic|internet)-password|Cookies\.binarycookies|Login\s+Data)/i,
    explanation: "Reads or transfers credentials, private keys, or broad home-directory secrets.",
    remediation: "Skills must not access user credentials; remove the instruction." },
  { ruleId: "SEC-001", severity: "medium", confidence: "low",
    pattern: /~\/\.ssh\/|~\/\.aws\/|~\/\.config\/gcloud|~\/\.kube\/config/i,
    explanation: "References a credential directory in the user's home.",
    remediation: "Confirm the skill does not read credentials." },
  { ruleId: "EXE-001", severity: "high", confidence: "high",
    pattern: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n|]{0,200}\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node|perl|ruby|iex|Invoke-Expression)\b|\b(bash|sh|zsh)\s+<\(\s*(curl|wget)\b|\biex\s*\(\s*(iwr|Invoke-WebRequest|New-Object\s+Net\.WebClient)/i,
    explanation: "Downloads remote content and pipes it straight into an interpreter.",
    remediation: "Pin and bundle reviewed content instead of executing remote downloads." },
  { ruleId: "EXE-002", severity: "high", confidence: "medium",
    pattern: /base64\s+(-d|--decode)[^\n]{0,40}\|\s*(sh|bash|zsh|python3?)\b|\beval\s*\(\s*(atob|Buffer\.from|base64)|\bexec\s*\(\s*(base64\.b64decode|bytes\.fromhex|codecs\.decode)|\b(eval|exec)\s*\(\s*(compile\s*\()?\s*__import__\s*\(\s*['"]base64/i,
    explanation: "Decodes an opaque payload and executes it.",
    remediation: "Ship readable source; obfuscated execution cannot be reviewed." },
  { ruleId: "EXE-002", severity: "medium", confidence: "low",
    pattern: /[A-Za-z0-9+/]{300,}={0,2}/,
    explanation: "Contains a long encoded blob whose purpose is not evident.", scope: "code",
    remediation: "Explain or remove the encoded data." },
  { ruleId: "FS-001", severity: "critical", confidence: "high",
    pattern: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(--no-preserve-root\s+)?(\/|~|\$HOME|\/\*|~\/\*|\$\{?HOME\}?\/\*)(\s|$|["'`;])|\bmkfs(\.\w+)?\s+\/dev\/|\bdd\s+[^\n]*of=\/dev\/(sd|disk|nvme|hd)|\bchmod\s+-R\s+0?777\s+\/(\s|$)/i,
    explanation: "Broad destructive filesystem command.",
    remediation: "Remove destructive commands that target the root or home directory." },
  { ruleId: "FS-001", severity: "high", confidence: "medium",
    pattern: />>?\s*(~|\$HOME|\$\{HOME\})\/\.(bashrc|zshrc|bash_profile|profile|zprofile|config\/fish\/config\.fish)\b|>\s*\/etc\/|\btee\s+(-a\s+)?\/etc\//i,
    explanation: "Writes to shell profiles or system configuration outside the project.",
    remediation: "Skills must not modify files outside the selected project." },
  { ruleId: "PERM-001", severity: "high", confidence: "high",
    pattern: /--dangerously-skip-permissions|\bbypassPermissions\b|--dangerously-bypass-approvals-and-sandbox|\bdisable\s+(the\s+)?(sandbox|safety\s+checks?|permission\s+prompts?|approvals?)\b|\bsandbox_mode\s*=\s*["']?danger-full-access|\bchmod\s+[ug]?\+s\b|(\.claude\/settings(\.local)?\.json|\.codex\/config\.toml)[^\n]{0,40}\b(allow|permissions|approval)/i,
    explanation: "Disables safeguards, preapproves broad tools, or changes agent permission policy.",
    remediation: "Remove instructions that alter permissions; the user grants permissions through the host." },
  { ruleId: "NET-001", severity: "medium", confidence: "medium",
    pattern: /\bcurl\b[^\n]{0,120}\s(-F|--form|-T|--upload-file|-d|--data(-binary|-raw)?)\s|\bscp\s+[^\n]*\s\S+@\S+:|\b(upload|send|post)\s+(the\s+)?(file|files|repo|repository|codebase|source|logs?)\s+to\b/i,
    explanation: "Uploads or transfers data to an external destination.",
    remediation: "Confirm the destination and what data leaves the machine." },
  { ruleId: "RUN-001", severity: "medium", confidence: "high",
    pattern: /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\s+(-g\s+)?[@a-z]|\bnpx\s+(-y\s+|--yes\s+)?[@a-z]|\bpip3?\s+install\s+[a-z]|\buv\s+(pip\s+install|tool\s+install|add)\s|\bbrew\s+install\s|\bapt(-get)?\s+install\s|\bgem\s+install\s|\bcargo\s+install\s|\bgo\s+install\s/i,
    explanation: "Instructs installing packages or tools.", scope: "prose",
    remediation: "Disclosure: SkillPilot never installs these; decide whether you trust them before the agent runs them." },
  { ruleId: "AGT-001", severity: "high", confidence: "high",
    pattern: /(^|\s)!`[^`\n]+`|^```!/m, scope: "skill-md",
    explanation: "Dynamic command interpolation runs shell commands when the skill loads.",
    remediation: "Remove `!` command interpolation; it executes before the user can review output." },
  { ruleId: "AGT-001", severity: "low", confidence: "medium",
    pattern: /\/Users\/[a-z][\w.-]+\/|\/home\/[a-z][\w.-]+\/|C:\\Users\\[A-Za-z][\w.-]+\\/,
    explanation: "Contains a hard-coded user home path.",
    remediation: "Use project-relative paths." },
  { ruleId: "DAT-001", severity: "high", confidence: "high", secret: true,
    pattern: /\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b|\bsk-ant-[A-Za-z0-9_-]{20,}|\bsk-(proj-)?[A-Za-z0-9]{32,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----|\bAIza[0-9A-Za-z_-]{35}\b/,
    explanation: "Appears to embed a secret credential value. Evidence is redacted.",
    remediation: "Remove the value upstream and rotate it if real." },
];

// DOC-001: lines that clearly present a pattern as something not to do.
const NEGATIVE_CONTEXT = /\b(never|do\s+not|don't|avoid|must\s+not|should\s+not|bad\s+(example|practice)|anti-?pattern|insecure\s+example|dangerous)\b|❌|⛔/i;

const SEVERITY_DOWN: Record<Severity, Severity> = { critical: "high", high: "medium", medium: "low", low: "low", info: "info" };

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Applies text rules to one decoded file. One finding per rule variant per file, at its first occurrence. */
export function scanText(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const isCode = CODE_EXT.test(file);
  const isSkillMd = file === "SKILL.md";
  const lines = text.split("\n");
  for (const rule of TEXT_RULES) {
    if (rule.scope === "code" && !isCode) continue;
    if (rule.scope === "prose" && isCode) continue;
    if (rule.scope === "skill-md" && !isSkillMd) continue;
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : rule.pattern.flags + "g");
    const matches = [...text.matchAll(re)];
    if (!matches.length) continue;
    const first = matches[0]!;
    const line = lineOf(text, first.index);
    // A finding is softened only when every occurrence sits in a negative-example line.
    const allNegative = !rule.secret && matches.every((m) => NEGATIVE_CONTEXT.test(lines[lineOf(text, m.index) - 1] ?? ""));
    const severity = allNegative ? SEVERITY_DOWN[rule.severity] : rule.severity;
    out.push({
      id: findingId(rule.ruleId, file, line, matches.map((m) => m[0]).join("\0")),
      ruleId: rule.ruleId,
      severity,
      confidence: allNegative ? "low" : rule.confidence,
      file,
      lineStart: line,
      lineEnd: line,
      occurrences: matches.length,
      explanation: rule.explanation,
      remediation: rule.remediation,
      blocking: severity === "high" || severity === "critical",
      ...(allNegative ? { context: "DOC-001: every occurrence appears in a negative-example line; severity lowered one level, evidence kept." } : {}),
    });
  }
  return out;
}
