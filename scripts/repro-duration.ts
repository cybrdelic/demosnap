import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runPipeline } from '../src/pipeline.js';

function probeDuration(file: string): number | null {
  if (!fs.existsSync(file)) return null;
  const res = spawnSync(
    'ffprobe',
    ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' }
  );
  if (res.status !== 0) return null;
  const v = parseFloat(res.stdout.trim());
  return isFinite(v) ? v : null;
}

async function main() {
  const outDir = path.resolve('studio_out', 'repro_' + Date.now());
  console.log('[repro] outDir', outDir);
  await runPipeline({
    url: 'https://example.com',
    title: 'Repro',
    subtitle: 'Duration',
    outDir,
    minDuration: 8000,
    debug: false,
    quality: 'auto',
  });
  const raw = path.join(outDir, 'raw.webm');
  const composed = path.join(outDir, 'composed.webm');
  const meta = path.join(outDir, 'compose-meta.json');
  const rawDur = probeDuration(raw);
  const compDur = probeDuration(composed);
  console.log('[repro] raw duration (s):', rawDur);
  console.log('[repro] composed duration (s):', compDur);
  if (fs.existsSync(meta)) {
    console.log('[repro] compose-meta.json:\n' + fs.readFileSync(meta, 'utf8'));
  } else {
    console.warn('[repro] compose-meta.json missing');
  }
  if (!compDur || compDur < 7.5) {
    console.error('[repro] FAIL: composed duration too short');
    process.exitCode = 1;
  } else {
    console.log('[repro] PASS: composed duration OK');
  }
}

main().catch((e) => {
  console.error('[repro] error', e);
  process.exit(1);
});
