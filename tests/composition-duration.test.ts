import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runPipeline } from '../src/pipeline.js';

function hasFfprobe() {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(cmd, ['ffprobe'], { encoding: 'utf8' });
  return r.status === 0;
}

function probe(file: string): number | null {
  if (!fs.existsSync(file) || !hasFfprobe()) return null;
  const r = spawnSync(
    'ffprobe',
    ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' }
  );
  if (r.status !== 0) return null;
  const v = parseFloat(r.stdout.trim());
  return isFinite(v) ? v : null;
}

test('composed >= 8s and nodeDone used', async () => {
  const outDir = path.resolve('studio_out', 'durtest_' + Date.now());
  await runPipeline({
    url: 'https://example.com',
    outDir,
    minDuration: 8000,
    title: 'DurTest',
    subtitle: 'Check',
    quality: 'auto',
  });
  const comp = path.join(outDir, 'composed.webm');
  const metaPath = path.join(outDir, 'compose-meta.json');
  assert.ok(fs.existsSync(comp), 'missing composed.webm');
  assert.ok(fs.existsSync(metaPath), 'missing compose-meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.equal(meta.nodeDoneCalled, true, 'fallback used instead of nodeDone');
  if (hasFfprobe()) {
    const d = probe(comp);
    assert.ok(d && d >= 7.8, 'duration too short: ' + d);
  }
}, 45000);
