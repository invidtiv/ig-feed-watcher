#!/usr/bin/env node
/**
 * IG Post API Server
 *
 * HTTP API that accepts an image file + caption and posts to Instagram
 * using the existing session cookies.
 *
 * Endpoints:
 *   GET  /health       — health check
 *   GET  /status       — cookie/session status
 *   POST /post         — upload image + caption, post to Instagram
 *     multipart/form-data:
 *       image   — image file (jpg, png)
 *       caption — post caption text (optional)
 *     OR JSON body:
 *       { "imagePath": "/abs/path/to/image.jpg", "caption": "text" }
 *
 * No authentication — bind to 127.0.0.1 / Tailnet only.
 * Default port: 4030 (configurable via IG_POST_API_PORT env var)
 */

import express from 'express';
import multer from 'multer';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { postToInstagram } from './poster.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const PORT = process.env.IG_POST_API_PORT || 4030;
const HOST = '127.0.0.1'; // Tailnet/internal only — no public exposure

const CONFIG = {
  cookiesFile: join(ROOT, 'cookies.json'),
  uploadsDir: join(ROOT, 'uploads'),
  logsDir: join(ROOT, 'logs'),
  maxFileSize: 20 * 1024 * 1024, // 20MB
};

// Ensure dirs exist
for (const dir of [CONFIG.uploadsDir, CONFIG.logsDir]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ─── Multer config ────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, CONFIG.uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = extname(file.originalname) || '.jpg';
    cb(null, `upload_${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: CONFIG.maxFileSize },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|webp|gif)$/;
    if (allowed.test(extname(file.originalname).toLowerCase()) || allowed.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files (jpg, png, webp, gif) are allowed'));
    }
  },
});

// ─── App ──────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [api] ${msg}`;
  console.error(line);
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ig-feed-watcher-post-api',
    uptime: process.uptime(),
    cookiesConfigured: existsSync(CONFIG.cookiesFile),
  });
});

app.get('/status', (req, res) => {
  if (!existsSync(CONFIG.cookiesFile)) {
    return res.json({
      status: 'error',
      message: 'cookies.json not found — export cookies first',
    });
  }

  let cookieCount = 0;
  let hasSessionId = false;
  try {
    const cookies = JSON.parse(readFileSync(CONFIG.cookiesFile, 'utf-8'));
    cookieCount = cookies.length;
    hasSessionId = cookies.some(c => c.name === 'sessionid');
  } catch (e) {
    return res.json({
      status: 'error',
      message: `Failed to parse cookies.json: ${e.message}`,
    });
  }

  res.json({
    status: 'ok',
    cookiesFile: CONFIG.cookiesFile,
    cookieCount,
    hasSessionId,
    message: hasSessionId
      ? 'Session cookies present (validity not checked)'
      : 'sessionid cookie missing — may not be logged in',
  });
});

// POST /post — multipart upload
app.post('/post', upload.single('image'), async (req, res) => {
  try {
    // Two modes: file upload OR imagePath in JSON
    let imagePath = null;
    let caption = '';

    if (req.file) {
      // Multipart mode
      imagePath = req.file.path;
      caption = req.body.caption || '';
      log(`Received upload: ${req.file.originalname} → ${imagePath}`);
    } else if (req.body.imagePath) {
      // JSON mode — use existing file on disk
      imagePath = req.body.imagePath;
      caption = req.body.caption || '';
      log(`Using existing image: ${imagePath}`);
    } else {
      return res.status(400).json({
        success: false,
        error: 'No image provided. Upload a file (multipart "image" field) or provide "imagePath" in JSON body.',
      });
    }

    if (!existsSync(imagePath)) {
      return res.status(400).json({
        success: false,
        error: `Image not found: ${imagePath}`,
      });
    }

    log(`Posting to Instagram: "${caption.slice(0, 80) || '(no caption)'}..."`);

    const result = await postToInstagram(imagePath, caption);

    if (result.success) {
      log(`Post successful: ${result.permalink || '(no permalink)'}`);
      res.json(result);
    } else {
      log(`Post failed: ${result.error}`);
      res.status(500).json(result);
    }
  } catch (err) {
    log(`Unhandled error: ${err.message}`);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────

app.listen(PORT, HOST, () => {
  log(`═══════════════════════════════════════════`);
  log(`IG Post API Server`);
  log(`  Listening: http://${HOST}:${PORT}`);
  log(`  Endpoints:`);
  log(`    GET  /health`);
  log(`    GET  /status`);
  log(`    POST /post  (multipart: image, caption)`);
  log(`    POST /post  (json: { imagePath, caption })`);
  log(`  Uploads:  ${CONFIG.uploadsDir}`);
  log(`  Cookies: ${CONFIG.cookiesFile}`);
  log(`═══════════════════════════════════════════`);
});
