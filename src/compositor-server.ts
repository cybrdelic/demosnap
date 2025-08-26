import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

export function createServer(videoPath: string) {
  const app = express();
  const resolved = path.resolve(videoPath);
  if (!fs.existsSync(resolved)) throw new Error('Video not found: ' + resolved);
  app.get('/video', (_req, res) => {
    res.sendFile(resolved);
  });
  app.use('/static', express.static(path.join(__dirname, '../public')));
  return app;
}
