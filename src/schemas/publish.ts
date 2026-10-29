import { z } from "zod";
import { JournalSchema, MutationLockSchema } from "../installer/index.ts";
import { PlanSchema } from "../planner/schemas.ts";
import { CatalogSchema } from "../sources/catalog.ts";
import { LockfileSchema } from "../storage/lockfile.ts";
import { ConfigSchema } from "./config.ts";
import { COMMAND_DATA, envelope } from "./contracts.ts";

function doc(file: string, title: string, schema: z.ZodType): [string, string] {
  const json = { title, ...z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" }) };
  return [file, JSON.stringify(json, null, 2) + "\n"];
}

/** Every published JSON Schema, keyed by its path under `schemas/`. Generated; never edited by hand. */
export function publishedSchemas(): Map<string, string> {
  return new Map([
    doc("envelope.schema.json", "SkillPilot JSON envelope (any command)", envelope("<command>", z.unknown()).extend({ command: z.string() })),
    ...Object.entries(COMMAND_DATA).map(([name, data]) => doc(`commands/${name.replace(" ", "-")}.schema.json`, `skillpilot ${name} --json`, envelope(name, data))),
    doc("config.schema.json", "SkillPilot project configuration (.skillpilot/config.json)", ConfigSchema),
    doc("catalog.schema.json", "SkillPilot bundled catalog (catalog/skills.json)", CatalogSchema),
    doc("plan.schema.json", "SkillPilot install or removal plan", PlanSchema),
    doc("lockfile.schema.json", "SkillPilot provenance lockfile (.skillpilot/lock.json)", LockfileSchema),
    doc("journal.schema.json", "SkillPilot operation journal (.skillpilot/operations/<id>/journal.json)", JournalSchema),
    doc("mutation-lock.schema.json", "SkillPilot project mutation lock (.skillpilot/mutation.lock)", MutationLockSchema),
  ]);
}
