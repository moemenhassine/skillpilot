// Identifies common license texts by distinctive phrases. Evidence only; never a legal opinion.
const TEXT_SIGNATURES: [string, RegExp][] = [
  ["Apache-2.0", /Apache License[\s\S]{0,40}Version 2\.0/i],
  ["MIT", /Permission is hereby granted, free of charge, to any person obtaining a copy/i],
  ["BSD-3-Clause", /Redistribution and use in source and binary forms[\s\S]*Neither the name/i],
  ["BSD-2-Clause", /Redistribution and use in source and binary forms/i],
  ["ISC", /Permission to use, copy, modify, and\/or distribute this software for any purpose/i],
  ["MPL-2.0", /Mozilla Public License,? (Version|v\.) ?2\.0/i],
  ["CC-BY-SA-4.0", /Attribution-ShareAlike 4\.0 International/i],
  ["CC-BY-4.0", /Attribution 4\.0 International/i],
  ["Unlicense", /This is free and unencumbered software released into the public domain/i],
];

const SPDX_FIELD = /^(Apache-2\.0|MIT|BSD-2-Clause|BSD-3-Clause|ISC|MPL-2\.0|CC-BY-SA-4\.0|CC-BY-4\.0|Unlicense)$/;

export function identifyLicenseText(text: string): string | null {
  return TEXT_SIGNATURES.find(([, re]) => re.test(text))?.[0] ?? null;
}

export interface LicenseEvidence {
  spdx: string | null;
  files: string[];
  manifestField: string | null;
  problem: string | null;
}

/** Combines the manifest `license` field with identified license files. Conflicts and absence are problems. */
export function assessLicense(manifestField: string | null, licenseFiles: { path: string; text: string }[]): LicenseEvidence {
  const identified = [...new Set(licenseFiles.map((f) => identifyLicenseText(f.text)).filter((x): x is string => x !== null))];
  const declared = manifestField && SPDX_FIELD.test(manifestField.trim()) ? manifestField.trim() : null;
  const files = licenseFiles.map((f) => f.path).sort();
  if (identified.length > 1) return { spdx: null, files, manifestField, problem: `License files disagree (${identified.join(", ")}).` };
  const fromFile = identified[0] ?? null;
  if (declared && fromFile && declared !== fromFile) return { spdx: null, files, manifestField, problem: `Manifest declares ${declared} but the license file reads as ${fromFile}.` };
  const spdx = fromFile ?? declared;
  if (!spdx) {
    return { spdx: null, files, manifestField, problem: files.length ? "License file present but not recognized." : "No license evidence in the payload or at the repository root." };
  }
  if (!fromFile) return { spdx, files, manifestField, problem: "Manifest declares a license but no matching license text is bundled for attribution." };
  return { spdx, files, manifestField, problem: null };
}
