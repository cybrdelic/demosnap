import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAutoFlow } from './auto-flow.js';
import { runPipeline } from './pipeline.js';

// ESM __dirname replacement
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createStudioServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const outRoot = path.resolve('studio_out');
  fs.mkdirSync(outRoot, { recursive: true });

  app.post('/api/compose', async (req: any, res: any) => {
    const { url, title, subtitle } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Missing url' });
    }
    try {
      const ts = Date.now();
      const outDir = path.join(outRoot, 'job_' + ts);
      const minDurationEnv = process.env.MIN_DURATION ? Number(process.env.MIN_DURATION) : 8000;
      const result = await runPipeline({
        url,
        title,
        subtitle,
        outDir,
        theme: 'minimal',
        minDuration: isFinite(minDurationEnv) && minDurationEnv > 0 ? minDurationEnv : 8000, // override via env
      });
      // Persist meta for UI enhancements
      try {
        fs.writeFileSync(
          path.join(outDir, 'meta.json'),
          JSON.stringify(
            { url, title, subtitle, events: result.events.length, created: ts },
            null,
            2
          )
        );
      } catch {}
      res.json({
        ok: true,
        id: 'job_' + ts,
        raw: path.relative(process.cwd(), result.raw),
        composed: path.relative(process.cwd(), result.composed),
        cover: path.relative(process.cwd(), result.cover),
      });
    } catch (e: any) {
      console.error('[studio] compose error', e);
      res.status(500).json({ error: e.message || 'compose failed' });
    }
  });

  // Compose from raw YAML (flow definition). Accepts { yaml, title?, subtitle? }
  app.post('/api/compose-yaml', async (req: any, res: any) => {
    const { yaml, title, subtitle } = req.body || {};
    if (!yaml || typeof yaml !== 'string') return res.status(400).json({ error: 'Missing yaml' });
    try {
      // Allow shorthand (just list of - action steps) by wrapping into a full flow definition
      let finalYaml = yaml;
      if (!/^\s*name:/m.test(finalYaml) && !/^\s*steps:/m.test(finalYaml)) {
        // Attempt to detect first goto to extract url; else require client provided url field (not yet) -> leave blank
        // If user included a special comment with source URL we can capture (# url: ...)
        let sourceUrl = '';
        const urlComment = finalYaml.match(/#\s*url:\s*(\S+)/i);
        if (urlComment) sourceUrl = urlComment[1];
        // If no explicit goto step exists, we cannot infer navigation; client should have inserted one.
        // Wrap
        finalYaml = [
          'name: Visual Timeline Flow',
          'viewport:',
          '  width: 1280',
          '  height: 720',
          'steps:',
          ...finalYaml
            .split(/\r?\n/)
            .map((l) => (l.startsWith('- action') ? '  ' + l : l.trim() ? '  ' + l : l)),
        ].join('\n');
      } else if (!/^\s*steps:/m.test(finalYaml)) {
        // Flow missing steps header but has content: insert steps:
        finalYaml = finalYaml + '\nsteps:';
      }
      const ts = Date.now();
      const outDir = path.join(outRoot, 'job_' + ts);
      fs.mkdirSync(outDir, { recursive: true });
      const flowPath = path.join(outDir, 'flow.yml');
      fs.writeFileSync(flowPath, finalYaml, 'utf8');
      // Attempt to extract a url from first goto step for link attribution (simple regex)
      let firstUrl: string | undefined;
      const m = finalYaml.match(/action:\s*goto\s*\n\s*url:\s*"?([^"\n]+)"?/);
      if (m) firstUrl = m[1].trim();
      const minDurationEnv = process.env.MIN_DURATION ? Number(process.env.MIN_DURATION) : 8000;
      const result = await runPipeline({
        url: firstUrl || 'about:blank',
        title,
        subtitle,
        outDir,
        theme: 'minimal',
        flowPath,
        minDuration: isFinite(minDurationEnv) && minDurationEnv > 0 ? minDurationEnv : 8000,
      });
      try {
        fs.writeFileSync(
          path.join(outDir, 'meta.json'),
          JSON.stringify(
            { fromYaml: true, title, subtitle, created: ts, events: result.events.length },
            null,
            2
          )
        );
      } catch {}
      res.json({
        ok: true,
        id: 'job_' + ts,
        composed: path.relative(process.cwd(), result.composed),
        cover: path.relative(process.cwd(), result.cover),
      });
    } catch (e: any) {
      console.error('[studio] compose-yaml error', e);
      res.status(500).json({ error: e.message || 'compose-yaml failed' });
    }
  });

  app.post('/api/auto-flow', async (req: any, res: any) => {
    const { url, maxActions, jobId } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url' });
    const id = jobId || 'af_' + Date.now();
    try {
      const progressEvents: any[] = [];
      const result = await generateAutoFlow({
        url,
        maxActions: maxActions ? Number(maxActions) : 6,
        onProgress: (ev) => progressEvents.push(ev),
      });
      res.json({
        ok: true,
        id,
        yaml: result.yaml,
        candidates: result.candidates,
        chosen: result.chosen,
        progress: progressEvents,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message || 'auto-flow failed' });
    }
  });

  // Simple Server-Sent Events stream for live auto-flow progress (one-shot per request)
  app.get('/api/auto-flow/stream', async (req: any, res: any) => {
    const url = req.query.url as string;
    const maxActions = req.query.maxActions ? Number(req.query.maxActions) : 6;
    if (!url) {
      res.status(400).end();
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const write = (ev: any) => res.write(`event: progress\ndata: ${JSON.stringify(ev)}\n\n`);
    write({ stage: 'init', message: 'Starting auto-flow', url });
    try {
      const result = await generateAutoFlow({ url, maxActions, onProgress: write });
      write({
        stage: 'complete',
        yaml: result.yaml,
        chosen: result.chosen,
        candidates: result.candidates,
      });
      res.write('event: end\ndata: done\n\n');
    } catch (e: any) {
      write({ stage: 'error', message: e.message || 'failed' });
      res.write('event: end\ndata: error\n\n');
    } finally {
      setTimeout(() => res.end(), 200);
    }
  });

  app.get('/api/jobs', (_req: any, res: any) => {
    const jobs = fs
      .readdirSync(outRoot)
      .filter((f) => f.startsWith('job_'))
      .map((j) => {
        const dir = path.join(outRoot, j);
        let meta: any = null;
        try {
          meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
        } catch {}
        const rawPath = path.join(dir, 'raw.webm');
        const composedPath = path.join(dir, 'composed.webm');
        return {
          id: j,
          composed: fs.existsSync(composedPath),
          cover: fs.existsSync(path.join(dir, 'cover.png')),
          rawSize: fs.existsSync(rawPath) ? fs.statSync(rawPath).size : 0,
          composedSize: fs.existsSync(composedPath) ? fs.statSync(composedPath).size : 0,
          events: meta ? meta.events : undefined,
          title: meta ? meta.title : undefined,
          url: meta ? meta.url : undefined,
          created: meta ? meta.created : undefined,
        };
      })
      .sort((a, b) => (a.id < b.id ? 1 : -1));
    res.setHeader('Cache-Control', 'no-store');
    res.json(jobs);
  });

  // Delete a job directory and its artifacts
  app.delete('/api/jobs/:id', (req: any, res: any) => {
    const id = String(req.params.id || '');
    if (!/^job_\d+$/.test(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const dir = path.join(outRoot, id);
    try {
      if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Not found' });
      fs.rmSync(dir, { recursive: true, force: true });
      res.json({ ok: true, id });
    } catch (e: any) {
      console.error('[studio] delete error', e);
      res.status(500).json({ error: e.message || 'delete failed' });
    }
  });

  // Static with no cache to avoid stale video/cover
  app.use(
    '/studio_out',
    express.static(outRoot, {
      setHeaders: (res: any) => {
        res.setHeader('Cache-Control', 'no-store');
      },
    })
  );

  app.get('/', (_req: any, res: any) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'studio.html'));
  });
  app.use(express.static(path.join(__dirname, '..', 'public')));
  return app;
}

// Auto-start: detect if this module is the entrypoint
try {
  const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
  const selfPath = path.resolve(__filename);
  // Fallback heuristic: if process argv contains 'studio-server' anywhere
  const shouldStart =
    invoked === selfPath || process.argv.some((a) => /studio-server\.ts|studio-server\.js/.test(a));
  const g = globalThis as any;
  if (shouldStart && !g.__STUDIO_SERVER_STARTED) {
    g.__STUDIO_SERVER_STARTED = true;
    const app = createStudioServer();
    const port = Number(process.env.PORT) || 7788;
    app.listen(port, () => {
      console.log('[studio] listening on http://localhost:' + port);
      console.log('[studio] OPEN http://localhost:' + port + ' in your browser');
      console.log('[studio] POST /api/compose { url, title?, subtitle? }');
    });
  }
} catch (e) {
  console.warn('[studio] auto-start detection failed', e);
}
