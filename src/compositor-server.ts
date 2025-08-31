import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Provide timeline events directly (avoid giant base64 query strings that can trigger 431 or URL length limits)
export function createServer(videoPath: string, timelineEvents?: any[]) {
  const app = express();
  const resolved = path.resolve(videoPath);
  if (!fs.existsSync(resolved)) throw new Error('Video not found: ' + resolved);
  app.get('/video', (_req, res) => {
    res.sendFile(resolved);
  });
  if (timelineEvents) {
    app.get('/timeline', (_req, res) => {
      res.json(timelineEvents);
    });
  }
  // Emulate __dirname for ES modules and serve compositor assets
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const publicDir = path.join(__dirname, '..', 'public');
  // Serve all public assets at root for relative script paths
  app.use(express.static(publicDir));
  // Serve Three.js module locally to avoid external CDN dependency
  const threeDir = path.join(__dirname, '..', 'node_modules', 'three', 'build');
  if (fs.existsSync(threeDir)) {
    app.use('/vendor/three', express.static(threeDir));
  }
  app.get('/compositor', (_req, res) => {
    res.sendFile(path.join(publicDir, 'compositor.html'));
  });
  app.get('/player', (_req, res) => {
    res.sendFile(path.join(publicDir, 'player.html'));
  });
  return app;
}
