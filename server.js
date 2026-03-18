require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
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

terminal.use(express.json());

// ── AI PICKS ──────────────────────────────────────────────────
terminal.post('/api/ai-picks', async (req, res) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.json({ error: 'ANTHROPIC_API_KEY not set in .env' });

  const userPrompt = (req.body?.prompt || '').slice(0, 500).trim() ||
    'Focus on current geopolitical tensions and sector rotation opportunities.';

  // Fetch fresh market news for context
  let headlines = '';
  try {
    const newsRes = await fetch(
      `${FINNHUB_BASE}/news?category=general&token=${FINNHUB_KEY}`
    );
    const newsData = await newsRes.json();
    if (Array.isArray(newsData)) {
      headlines = newsData.slice(0, 20).map(n => `- ${n.headline}`).join('\n');
    }
  } catch { /* continue without news */ }

  const systemPrompt = `You are a quantitative macro trader analyzing global markets.
Based on current news and geopolitical data, pick exactly 10 tickers to go LONG and 10 to SHORT.
Choose real, liquid, US-listed stocks or ETFs (NYSE/NASDAQ). Mix sectors.
Respond ONLY with valid JSON — no markdown, no explanation outside JSON:
{"long":[{"sym":"TICKER","reason":"one sentence","sector":"sector"}],"short":[{"sym":"TICKER","reason":"one sentence","sector":"sector"}]}`;

  const userMessage = `Current market headlines:\n${headlines || 'No news available.'}\n\nUser focus: ${userPrompt}\n\nPick 10 LONG and 10 SHORT tickers with reasons.`;

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    const aiData = await aiRes.json();
    const raw = aiData?.content?.[0]?.text || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.json({ error: 'AI returned invalid format', raw });
    const picks = JSON.parse(jsonMatch[0]);
    res.json(picks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

terminal.post('/api/trigger-brief', async (req, res) => {
  try {
    await pushService.triggerMorningBrief();
    res.json({ ok: true, message: 'Morning brief sent to Discord' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

startServer(terminal, PORT_TERMINAL, '⚡ OpenClaw Terminal ');

// ── WORLDMONITOR ───────────────────────────────────────────────
const wmDist = path.join(__dirname, 'worldmonitor', 'dist');

if (fs.existsSync(wmDist)) {
  // ── Spawn internal API server (TypeScript handlers via tsx) ──────────────
  const API_PORT = parseInt(process.env.API_SERVER_PORT || '3002');
  const tsxBin = path.join(__dirname, 'worldmonitor', 'node_modules', '.bin', 'tsx');
  const apiServerScript = path.join(__dirname, 'worldmonitor', 'api-server.ts');

  if (fs.existsSync(tsxBin) && fs.existsSync(apiServerScript)) {
    const apiProc = spawn(tsxBin, [apiServerScript], {
      env: { ...process.env, API_SERVER_PORT: String(API_PORT) },
      stdio: 'inherit',
      shell: false,
    });
    apiProc.on('error', (err) => console.error('  ✖  API server failed to start:', err.message));
    apiProc.on('exit', (code) => {
      if (code !== 0 && code !== null) console.error(`  ✖  API server exited with code ${code}`);
    });
    process.on('exit', () => apiProc.kill());
  } else {
    console.warn('  ⚠  API server not started — tsx or api-server.ts not found');
  }

  const wm = express();

  // Proxy /api/{domain}/v1/* → internal API server
  wm.use((req, res, next) => {
    if (!/^\/api\/[a-z-]+\/v1\//.test(req.path)) return next();
    const headers = Object.assign({}, req.headers);
    delete headers['origin'];
    delete headers['host'];
    const proxyReq = http.request(
      `http://127.0.0.1:${API_PORT}${req.originalUrl}`,
      { method: req.method, headers },
      (proxyRes) => {
        const outHeaders = {};
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (!['transfer-encoding', 'connection'].includes(k.toLowerCase())) outHeaders[k] = v;
        }
        res.writeHead(proxyRes.statusCode, outHeaders);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on('error', (err) => {
      if (!res.headersSent) res.status(502).json({ error: 'API server unavailable', detail: err.message });
    });
    req.pipe(proxyReq);
  });

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
