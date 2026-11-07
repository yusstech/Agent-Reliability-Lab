// Re-derives cases.csv, summary.json and report.md for a run from its events.jsonl.
// Usage: npm run eval:score -- results/<run-id>
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { scoreRun } from '../src/eval/artifacts.ts';
import type { Dataset } from '../src/eval/dataset.ts';

const dir = process.argv[2];
if (!dir) throw new Error('usage: npm run eval:score -- results/<run-id>');
const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
const dataset = JSON.parse(await readFile(path.resolve(import.meta.dirname, '..', manifest.dataset.path), 'utf8')) as Dataset;
const { summary } = await scoreRun(dir, dataset);
console.log(`rescored ${dir}: ${summary.counts.valid} case-runs, false claims ${summary.false_claim.count}`);
