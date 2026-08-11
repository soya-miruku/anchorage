/**
 * Lifts the release job's signing step out of the workflow, so the harness runs what the runner
 * will run rather than a copy that can drift from it.
 *
 * Reads the block scalar by indentation, which is exactly what YAML does for `run: |`: the block
 * is every following line indented further than the key, with blank lines belonging to it. That
 * is enough here and needs no dependency — this repository has none, and adding a YAML parser to
 * read one string would be a poor trade.
 */
import { readFileSync } from "node:fs";

const STEP = "Checksums, and a signature if a key is configured";

const lines = readFileSync(process.argv[2], "utf8").split("\n");
const start = lines.findIndex((line) => line.includes(`- name: ${STEP}`));
if (start < 0) {
  console.error(`No step named ${JSON.stringify(STEP)} in ${process.argv[2]}.`);
  process.exit(1);
}
const runAt = lines.findIndex((line, index) => index > start && /^\s*run: \|\s*$/u.test(line));
if (runAt < 0) {
  console.error(`The step ${JSON.stringify(STEP)} has no "run: |" block.`);
  process.exit(1);
}
const indent = lines[runAt].length - lines[runAt].trimStart().length + 2;
const body = [];
for (let index = runAt + 1; index < lines.length; index += 1) {
  const line = lines[index];
  if (line.trim() === "") {
    body.push("");
    continue;
  }
  if (line.length - line.trimStart().length < indent) break;
  body.push(line.slice(indent));
}
process.stdout.write(`${body.join("\n").trimEnd()}\n`);
