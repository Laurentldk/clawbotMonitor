require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const pushService = require('./lib/push-service');

// ── API KEYS (loaded from .env — never hardcoded) ─────────────
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const PORT_TERMINAL = parseInt(process.env.PORT || '3001');
const PORT_WM       = parseInt(process.env.PORT_WM || '3000');

if (!FINNHUB_KEY) {
  console.error('\n  ERROR: FINNHUB_KEY is not set. Create a .env file — see .env.example\n');
  process.exit(1);
}

function startServer(app, port, label) {
  const server = app.listen(port, () => {
    console.log(`  ${label}  →  http://localhost:${port}`);
  });
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`  ✖  Port ${port} already in use — kill the old process first:`);
      console.error(`     taskkill /F /IM node.exe`);
    } else {
      console.error(`  ✖  ${label} failed: ${err.message}`);
    }
  });
}

// ── OPENCLAW INTELLIGENCE TERMINAL ────────────────────────────
const terminal = express();
terminal.use(express.static(path.join(__dirname, 'public')));

terminal.get('/api/finnhub/*', async (req, res) => {
  try {
    const endpoint = req.path.replace('/api/finnhub', '');
    const query = new URLSearchParams(req.query).toString();
    const url = `${FINNHUB_BASE}${endpoint}?${query}&token=${FINNHUB_KEY}`;
    const response = await fetch(url);
    res.json(await response.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

terminal.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

startServer(terminal, PORT_TERMINAL, '⚡ OpenClaw Terminal ');

// ── WORLDMONITOR ───────────────────────────────────────────────
const wmDist = path.join(__dirname, 'worldmonitor', 'dist');

if (fs.existsSync(wmDist)) {
  const wm = express();

  // Push notification endpoints
  wm.get('/api/push/vapid-public-key', (_req, res) => {
    const key = pushService.getVapidPublicKey();
    if (!key) return res.status(503).json({ error: 'Push not configured' });
    res.json({ publicKey: key });
  });

  wm.post('/api/push/subscribe', express.json(), (req, res) => {
    try {
      pushService.addSubscription(req.body);
      res.status(201).json({ ok: true });
    } catch {
      res.status(400).json({ error: 'Invalid subscription' });
    }
  });

  wm.post('/api/push/unsubscribe', express.json(), (req, res) => {
    pushService.removeSubscription(req.body.endpoint);
    res.json({ ok: true });
  });

  // RSS proxy — WorldMonitor fetches /api/rss-proxy?url=<feed> to avoid CORS
  wm.get('/api/rss-proxy', async (req, res) => {
    const feedUrl = req.query.url;
    if (!feedUrl || !feedUrl.startsWith('http')) {
      return res.status(400).send('Missing or invalid url parameter');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const upstream = await fetch(feedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      clearTimeout(timer);
      const body = await upstream.text();
      res.set('Content-Type', 'application/xml; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=120');
      res.set('Access-Control-Allow-Origin', '*');
      res.status(upstream.status).send(body);
    } catch (err) {
      clearTimeout(timer);
      const isTimeout = err.name === 'AbortError';
      res.status(isTimeout ? 504 : 502).send(`RSS proxy error: ${err.message}`);
    }
  });

  wm.use(express.static(wmDist));
  wm.get('*', (req, res) => {
    res.sendFile(path.join(wmDist, 'index.html'));
  });
  startServer(wm, PORT_WM, '🌍 WorldMonitor      ');
  pushService.init();
} else {
  console.log(`  ⚠  WorldMonitor dist not found — run: npm run wm:build`);
}
