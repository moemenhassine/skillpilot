// Offline catalog schema + coverage gate (FR-015, FR-016). Current-source verification is a separate release check.
import { readFileSync } from "node:fs";
import { catalogCoverage, validateCatalog } from "../src/sources/catalog.ts";

const file = new URL("../catalog/skills.json", import.meta.url);
const { catalog, problems } = validateCatalog(JSON.parse(readFileSync(file, "utf8")));
if (!catalog) {
  console.error("Catalog is invalid:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(2);
}
const cov = catalogCoverage(catalog);
console.log(`Catalog ${catalog.catalogVersion}: ${cov.entries} entries, ${cov.categories.length} categories, ${cov.publishers.length} publishers`);
for (const [cat, c] of Object.entries(cov.baseline)) console.log(`  ${cat.padEnd(24)} ${c.candidates} candidates, ${c.installableUnderPolicy} installable under ${cov.policyVersion}`);
const hard = cov.gaps.filter((g) => !g.includes("installable"));
for (const g of cov.gaps) console.log(`${hard.includes(g) ? "FAIL" : "GAP "} ${g}`);
process.exit(hard.length ? 1 : 0);
