/* eslint-disable simple-header/header -- re-port tooling shipped with the MIT-licensed port */
// One-shot splitter: Undiscord-Lite userscript bundle -> Vencord userplugin modules.
// Run from the plugin folder:  node tools/split-undiscord.mjs <path/to/Undiscord-Lite.user.js>
// Writes all modules except index.tsx/HeaderButton.tsx into the plugin folder itself
// (pass a second argument to target another directory).
import { mkdirSync,readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2];
const OUT = process.argv[3] ?? path.join(HERE, "..");
if (!SRC) {
    console.error("usage: node tools/split-undiscord.mjs <undiscord.user.js> [outdir]");
    process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const lines = readFileSync(SRC, "utf8").split(/\r?\n/);

const NAME_MAP = {
    "src/ui/styles.css": "styles",
    "src/ui/undiscord.html": "template",
    "src/helpers.js": "helpers",
    "src/undiscord-core.js": "core",
    "src/ui/drag.js": "drag",
    "src/export-import.js": "exportImport",
    "src/undiscord-ui.js": "ui",
    "src/index.js": null,
};

// locate module ranges
const mods = [];
for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^__modules\["(.+?)"\] = \(__exports\) => \{$/);
    if (!m) continue;
    let end = i + 1;
    while (lines[end] !== "};") end++;
    mods.push({ key: m[1], start: i + 1, end });
}
// zh layer: after the bootstrap require line until the closing })();
const bootIdx = lines.findIndex(l => l === '__require("src/index.js");');
let zhEnd = lines.length - 1;
while (lines[zhEnd] !== "})();") zhEnd--;
const zhBody = lines.slice(bootIdx + 1, zhEnd).join("\n");

const HEADER = [
    "// @ts-nocheck",
    "/*",
    " * Ported from Undiscord Lite 1.3.0-zh (userscript, MIT, by OrbitalCheese).",
    " * That repository is no longer public. Undiscord Lite is itself derived from",
    " * victornpb/undiscord (MIT, https://github.com/victornpb/undiscord); the",
    " * original copyright notice is kept in THIRD-PARTY-NOTICES.md.",
    " * Mechanical split: bundled module registry converted to real ESM. Only the",
    " * marked adapter functions were rewritten; delete/search logic is upstream",
    " * verbatim.",
    " */",
    "",
    ""
].join("\n");

function transform(body) {
    // require destructuring -> named imports
    body = body.replace(/const \{([^}]+)\} = __require\("([^"]+)"\);/g,
        (_, names, src) => `import {${names}} from "./${NAME_MAP[src]}";`);
    // default requires (possibly several statements on one line) -> default imports
    body = body.replace(/const (\w+) = __require\("([^"]+)"\)\.default;/g,
        (_, id, src) => `import ${id} from "./${NAME_MAP[src]}";`);
    // __exports.default = X; -> export default X;
    body = body.replace(/^(\s*)__exports\.default = /gm, "$1export default ");
    // collect __exports.X = X; lines -> single export list
    const names = [];
    body = body.replace(/^(\s*)__exports\.(\w+) = \2;[ \t]*\r?\n?/gm, (_, _sp, n) => { names.push(n); return ""; });
    if (names.length) body += "\nexport { " + names.join(", ") + " };\n";
    return HEADER + body;
}

function dedent(s) {
    return s.split("\n").map(l => l.startsWith("  ") ? l.slice(2) : l).join("\n");
}

for (const m of mods) {
    if (!NAME_MAP[m.key]) continue;
    const out = NAME_MAP[m.key];
    let body = lines.slice(m.start, m.end).join("\n");
    body = transform(dedent(body));
    writeFileSync(`${OUT}/${out}.ts`, body + "\n");
    console.log(out + ".ts", lines.slice(m.start, m.end).length, "lines");
}

// zh layer -> zhLayer.ts with an exported entry
let zh = dedent(zhBody.trim().replace(/\n\n+$/, ""));
// the polling bootstrap at the end becomes an exported starter
zh = zh.replace(/^waitForUndiscordChineseUi\(\);$/m,
    "export function startChineseLayer() {\n    waitForUndiscordChineseUi();\n}");
writeFileSync(`${OUT}/zhLayer.ts`, HEADER + zh + "\n");
console.log("zhLayer.ts", zhBody.length);
