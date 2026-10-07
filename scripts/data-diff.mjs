// node scripts/data-diff.mjs <before-data-dir> <after-data-dir>  → markdown summary on stdout.
import { loadStack } from "../lib/stack.mjs";
import { diffStacks, diffMarkdown } from "../lib/data-diff.mjs";

const [beforeDir, afterDir] = process.argv.slice(2);
if (!beforeDir || !afterDir) {
  console.error("usage: node scripts/data-diff.mjs <before-data-dir> <after-data-dir>");
  process.exit(2);
}
const before = loadStack(beforeDir);
const after = loadStack(afterDir);
const labels = new Map([...before.nodes, ...after.nodes].map((n) => [n.id, n.label]));
console.log(diffMarkdown(diffStacks(before, after), (id) => labels.get(id) ?? ""));
