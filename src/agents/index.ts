import os from "node:os";
import path from "node:path";

export type AgentTarget = "claude-code" | "codex";
export const AGENT_TARGETS: readonly AgentTarget[] = ["claude-code", "codex"];

/** Fixed project-relative skill roots (spec 13.3; verified in docs/compatibility.md). */
export const PROJECT_SKILL_ROOTS: Record<AgentTarget, string> = {
  "claude-code": ".claude/skills",
  codex: ".agents/skills",
};

/** Documented user-level roots, read only for same-name inventory warnings (FR-006). */
export function userSkillRoot(agent: AgentTarget, home = os.homedir()): string {
  return agent === "claude-code" ? path.join(home, ".claude", "skills") : path.join(home, ".agents", "skills");
}

