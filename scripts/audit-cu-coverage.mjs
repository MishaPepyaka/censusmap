import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const importPath = path.join(repoRoot, "data", "import", "proxy4622_cu.geojson");
const cldRoot = path.join(repoRoot, "data", "cld");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function extractCu(feature) {
  const props = feature?.properties || {};
  const raw = props.CUID ?? props.cu ?? "";
  return String(raw).trim();
}

function sortedUnique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

const imported = readJson(importPath);
const importedCodes = sortedUnique((imported.features || []).map(extractCu));

const liveByCld = [];
for (const entry of fs.readdirSync(cldRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory()) continue;
  const cuPath = path.join(cldRoot, entry.name, "cu.geojson");
  if (!fs.existsSync(cuPath)) continue;
  const geojson = readJson(cuPath);
  const codes = sortedUnique((geojson.features || []).map(extractCu));
  liveByCld.push({ cld: entry.name, codes });
}

const liveCodes = sortedUnique(liveByCld.flatMap((row) => row.codes));
const liveSet = new Set(liveCodes);
const missingCodes = importedCodes.filter((code) => !liveSet.has(code));

const report = [
  "# CU Coverage Audit",
  "",
  "- Source import file: `data/import/proxy4622_cu.geojson`",
  `- Imported CU count: ${importedCodes.length}`,
  `- Live CU count: ${liveCodes.length}`,
  `- Missing CU count: ${missingCodes.length}`,
  "",
  "## Live CU By CLD",
  ""
];

for (const row of liveByCld) {
  report.push(`- CLD ${row.cld}: ${row.codes.length} CU`);
  report.push(`  - ${row.codes.join(", ")}`);
}

report.push("", "## Missing CU", "");
for (const code of missingCodes) {
  report.push(`- ${code}`);
}

const markdown = `${report.join("\n")}\n`;

if (process.argv.includes("--write")) {
  fs.writeFileSync(path.join(repoRoot, "docs", "CU_COVERAGE_AUDIT.md"), markdown);
}

process.stdout.write(markdown);
