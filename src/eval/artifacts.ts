// Reads and writes results/<run-id>/ (Documentation Standard: manifest, events, cases,
// summary). Derived files are always recomputed from events.jsonl.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Dataset } from './dataset.ts';
import { renderReport } from './report.ts';
import type { RawCaseRun } from './run-variant-a.ts';
import { type CaseRunScore, scoreCaseRun, summarize } from './score.ts';

export async function readRaw(dir: string): Promise<RawCaseRun[]> {
  const text = await readFile(path.join(dir, 'events.jsonl'), 'utf8');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as RawCaseRun);
}

const CSV_COLUMNS: (keyof CaseRunScore)[] = ['case_id', 'rep', 'category', 'variant', 'harness_error', 'claim', 'truth', 'false_success', 'false_failure', 'acceptable', 'correct', 'gated_success', 'violations', 'procedure', 'mutations', 'latency_ms', 'final_reason'];

function csvCell(v: unknown): string {
  const s = Array.isArray(v) ? v.join(';') : typeof v === 'object' && v !== null ? Object.entries(v).map(([k, x]) => `${k}=${x}`).join(';') : String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Scores raw records and (re)writes cases.csv, summary.json and report.md. */
export async function scoreRun(dir: string, dataset: Dataset) {
  const raw = await readRaw(dir);
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  const byId = new Map(dataset.cases.map((c) => [c.id, c]));
  const scores = raw.map((r) => {
    const c = byId.get(r.case_id);
    if (!c) throw new Error(`raw record for unknown case ${r.case_id}`);
    return scoreCaseRun(c, r);
  });
  const summary = summarize(dataset, scores);
  await writeFile(path.join(dir, 'cases.csv'), `${[CSV_COLUMNS.join(','), ...scores.map((s) => CSV_COLUMNS.map((k) => csvCell(s[k])).join(','))].join('\n')}\n`);
  await writeFile(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(path.join(dir, 'report.md'), renderReport(manifest, summary));
  return { scores, summary };
}
