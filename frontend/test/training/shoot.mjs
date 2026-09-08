/**
 * THE SHOT LIST — assembled from every shots.*.mjs group file in this folder.
 *
 *   node frontend/test/training/shoot.mjs            # everything
 *   node frontend/test/training/shoot.mjs roadmap    # ids/pages matching "roadmap"
 *   SHOT_PORT=8901 node frontend/test/training/shoot.mjs 05-   # a second run in parallel
 *
 * Groups are separate files so several people (or agents) can work on different
 * pages at once without touching each other's list. Shots sort by id, and the
 * ids are ordered as the CONSULTANT WORKFLOW runs, because the training script
 * follows the same order and the numbers are how it refers to the pictures.
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { run } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const groups = readdirSync(HERE)
  .filter((f) => /^shots\..+\.mjs$/.test(f))
  .sort();

const SHOTS = [];
for (const g of groups) {
  const mod = await import(pathToFileURL(join(HERE, g)).href);
  const list = mod.SHOTS || mod.default;
  if (!Array.isArray(list)) {
    console.error(`  !! ${g} exports no SHOTS array — skipped`);
    continue;
  }
  for (const s of list) SHOTS.push({ ...s, group: g });
}

SHOTS.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const dupes = SHOTS.map((s) => s.id).filter((id, i, all) => all.indexOf(id) !== i);
if (dupes.length) {
  console.error(`  !! duplicate shot ids: ${[...new Set(dupes)].join(', ')}`);
  process.exit(1);
}

console.log(`\n  ${SHOTS.length} shots from ${groups.length} group(s): ${groups.join(', ')}\n`);
await run(SHOTS, process.argv[2]);
