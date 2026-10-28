import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "tests/fixtures"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  // noUncheckedIndexedAccess is on; asserted indexes are deliberate after explicit bounds checks.
  { rules: { "@typescript-eslint/no-non-null-assertion": "off" } },
);
