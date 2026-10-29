// Writes schemas/ from the zod contracts. `--check` fails if the checked-in files differ.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { publishedSchemas } from "../src/schemas/publish.ts";

const root = path.resolve(import.meta.dirname, "../schemas");
const check = process.argv.includes("--check");
let stale = 0;
for (const [rel, content] of publishedSchemas()) {
  const file = path.join(root, rel);
  if (check) {
    if ((await readFile(file, "utf8").catch(() => null)) !== content) { console.error(`stale: schemas/${rel}`); stale++; }
  } else {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}
if (stale) { console.error("Run npm run schemas to regenerate."); process.exit(1); }
console.log(check ? "schemas/ is up to date." : `Wrote ${publishedSchemas().size} schemas to schemas/.`);
