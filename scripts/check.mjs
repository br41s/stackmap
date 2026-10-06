// npm run check — merge data/*.json and list every problem. Exit 1 on errors.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStack } from "../lib/stack.mjs";

const stack = loadStack(join(dirname(fileURLToPath(import.meta.url)), "..", "data"));
const errors = stack.issues.filter((i) => i.level === "error");
for (const i of stack.issues) console.log(`${i.level.padEnd(5)} ${i.file}: ${i.message}`);

const byKind = {};
for (const n of stack.nodes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
console.log(`\n${stack.nodes.length} nodes, ${stack.edges.length} edges, ${errors.length} errors, ${stack.issues.length - errors.length} warnings`);
console.log(Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · "));
process.exit(errors.length ? 1 : 0);
