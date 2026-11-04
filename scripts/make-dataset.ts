// Writes datasets/r-dev-v1.json from the base fixture and the dataset seed.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateFixture } from '../fixtures/generate.ts';
import { buildDataset, datasetDigest } from '../src/eval/dataset.ts';

export const R_DEV_SEED = 20261104;
const d = buildDataset(generateFixture(), R_DEV_SEED);
await writeFile(path.resolve(import.meta.dirname, '../datasets/r-dev-v1.json'), `${JSON.stringify(d, null, 2)}\n`);
console.log(`wrote ${d.version}: ${d.cases.length} cases, sha256 ${datasetDigest(d)}`);
