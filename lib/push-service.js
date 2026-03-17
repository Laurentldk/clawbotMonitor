/**
 * push-service.js
 * Server-side: VAPID key management, push subscriptions, RSS news poller,
 * Discord webhook dispatcher.
 */

const webpush  = require('web-push');
const fetch    = require('node-fetch');
const fs       = require('fs');
const path     = require('path');

// ── Paths ─────────────────────────────────────────────────────
const DATA_DIR   = path.join(__dirname, '..', 'data');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const SUBS_FILE  = path.join(DATA_DIR, 'push-subscriptions.json');
const SEEN_FILE  = path.join(DATA_DIR, 'seen-news.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── VAPID key management ──────────────────────────────────────
function loadOrGenerateVapidKeys() {
  ensureDataDir();

  // Prefer env vars (set these on the server for persistence across deploys)
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey:  process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
    };
  }

  if (fs.existsSync(VAPID_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    } catch { /* fall through to generate */ }
  }

  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
  console.log('  🔑 VAPID keys generated — add to .env for persistence:');
  console.log(`     VAPID_PUBLIC_KEY=${keys.publicKey}`);
  console.log(`     VAPID_PRIVATE_KEY=${keys.privateKey}`);
  return keys;
}

// ── Subscription storage ──────────────────────────────────────
function loadSubscriptions() {
  ensureDataDir();
  try {
    if (fs.existsSync(SUBS_FILE)) {
      return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return [];
}

function saveSubscriptions(subs) {
  ensureDataDir();
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
}

function addSubscription(sub) {
  const subs = loadSubscriptions();
  const exists = subs.some(s => s.endpoint === sub.endpoint);
  if (!exists) {
    subs.push(sub);
    saveSubscriptions(subs);
  }
}

function removeSubscription(endpoint) {
  const subs = loadSubscriptions().filter(s => s.endpoint !== endpoint);
  saveSubscriptions(subs);
}

// ── Seen-news deduplication ───────────────────────────────────
const seenIds = new Set();

function loadSeenIds() {
  ensureDataDir();
  try {
    if (fs.existsSync(SEEN_FILE)) {
      const arr = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
      arr.forEach(id => seenIds.add(id));
    }
  } catch { /* ignore */ }
}

function markSeen(id) {
  seenIds.add(id);
  // Keep file capped at 500 entries
  const arr = [...seenIds].slice(-500);
  try { fs.writeFileSync(SEEN_FILE, JSON.stringify(arr)); } catch { /* ignore */ }
}

// ── RSS feeds to monitor ──────────────────────────────────────
const WATCH_FEEDS = [
  'https://feeds.bbci.co.uk/news/rss.xml',
  'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
  'https://feeds.reuters.com/reuters/topNews',
  'https://rss.dw.com/xml/rss-en-world',
];

const BREAKING_KEYWORDS = [
  'breaking', 'urgent', 'alert', 'emergency', 'explosion', 'attack',
  'missile', 'strike', 'earthquake', 'tsunami', 'shooting', 'coup',
  'invasion', 'war declared', 'nuclear', 'ceasefire', 'crash',
];

function isBreaking(title) {
  const lower = title.toLowerCase();
  return BREAKING_KEYWORDS.some(kw => lower.includes(kw));
}

function extractItems(xml) {
  const items = [];
  const itemRegex = /<item[\s\S]*?<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[0];
    const title = (/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>/.exec(block) ||
                   /<title[^>]*>([\s\S]*?)<\/title>/.exec(block))?.[1]?.trim() ?? '';
    const link  = (/<link>([\s\S]*?)<\/link>/.exec(block))?.[1]?.trim() ??
                  (/<link[^>]+href="([^"]+)"/.exec(block))?.[1]?.trim() ?? '';
    const guid  = (/<guid[^>]*>([\s\S]*?)<\/guid>/.exec(block))?.[1]?.trim() ?? link;
    if (title && guid) items.push({ title, link, guid });
  }
  return items;
}

async function fetchFeed(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WorldMonitor/1.0)' },
      timeout: 8000,
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return extractItems(xml);
  } catch {
    return [];
  }
}

// ── Push sender ───────────────────────────────────────────────
let vapidKeys = null;

async function sendPushToAll(payload) {
  const subs = loadSubscriptions();
  if (!subs.length) return;

  const dead = [];
  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload));
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          dead.push(sub.endpoint);
        }
      }
    })
  );

  // Remove expired subscriptions
  if (dead.length) {
    const cleaned = loadSubscriptions().filter(s => !dead.includes(s.endpoint));
    saveSubscriptions(cleaned);
  }
}

// ── Country helpers ───────────────────────────────────────────
const COUNTRY_NAMES = {
  US:'United States',RU:'Russia',CN:'China',UA:'Ukraine',IR:'Iran',IL:'Israel',
  TW:'Taiwan',KP:'North Korea',SA:'Saudi Arabia',TR:'Turkey',PL:'Poland',
  DE:'Germany',FR:'France',GB:'UK',IN:'India',PK:'Pakistan',SY:'Syria',
  YE:'Yemen',MM:'Myanmar',VE:'Venezuela',CU:'Cuba',MX:'Mexico',BR:'Brazil',
  AE:'UAE',CD:'DR Congo',AF:'Afghanistan',IQ:'Iraq',LY:'Libya',SO:'Somalia',
  SD:'Sudan',NG:'Nigeria',ET:'Ethiopia',AZ:'Azerbaijan',AM:'Armenia',
};

function countryFlag(code) {
  if (!code || code.length !== 2) return '🌍';
  return String.fromCodePoint(...code.toUpperCase().split('').map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

// ── Country commodity exposure labels + related market tickers ─────────────────
// Resources = key commodities that country is a major producer/exporter of.
// Tickers   = publicly-traded companies/ETFs most exposed to those commodities.
const COUNTRY_COMMODITIES = {
  KP: { resources: 'Rare Earth · Coal · Iron Ore',        tickers: ['MP','TMC','UUUU','REMX'] },
  CN: { resources: 'Rare Earth · Coal · Copper · Solar',  tickers: ['REMX','MP','VALE','COPX'] },
  RU: { resources: 'Palladium · Nickel · Oil · Gas',      tickers: ['PALL','XOM','CVX','SLB'] },
  UA: { resources: 'Wheat · Steel · Titanium · Corn',     tickers: ['VALE','NEM'] },
  IR: { resources: 'Oil · Natural Gas',                   tickers: ['XOM','CVX','SLB'] },
  IQ: { resources: 'Oil · Natural Gas',                   tickers: ['XOM','CVX','SLB'] },
  LY: { resources: 'Oil',                                 tickers: ['XOM','CVX'] },
  SA: { resources: 'Oil · Natural Gas',                   tickers: ['XOM','CVX','SLB'] },
  AE: { resources: 'Oil · Natural Gas · Finance',         tickers: ['XOM','CVX'] },
  YE: { resources: 'Oil · LNG',                           tickers: ['XOM','CVX'] },
  SY: { resources: 'Oil · Phosphate',                     tickers: ['XOM','MOS'] },
  NG: { resources: 'Oil · Natural Gas · Iron Ore',        tickers: ['XOM','CVX','SLB'] },
  SD: { resources: 'Gold · Oil · Chromite',               tickers: ['NEM','GOLD','GFI'] },
  ET: { resources: 'Gold · Coffee · Potash',              tickers: ['NEM','GFI'] },
  CD: { resources: 'Cobalt · Copper · Coltan',            tickers: ['VALE','LIT','CATH'] },
  AF: { resources: 'Lithium · Rare Earth · Copper',       tickers: ['MP','ALB','REMX','FCX'] },
  MM: { resources: 'Rare Earth · Jade · Tin · Gas',       tickers: ['MP','REMX','XOM'] },
  TW: { resources: 'Semiconductors · Electronics',        tickers: ['TSM','INTC','NVDA','AMAT'] },
  IN: { resources: 'Coal · Iron Ore · Rare Earth',        tickers: ['VALE','COPX','MP'] },
  PK: { resources: 'Coal · Copper',                       tickers: ['FCX','COPX'] },
  VE: { resources: 'Oil · Gold · Bauxite',                tickers: ['XOM','GOLD','GFI'] },
  CU: { resources: 'Nickel · Cobalt · Oil',               tickers: ['NEM','VALE','LIT'] },
  MX: { resources: 'Silver · Oil · Copper',               tickers: ['PAAS','FCX','SLV'] },
  BR: { resources: 'Iron Ore · Gold · Nickel',            tickers: ['VALE','NEM','GOLD'] },
  AM: { resources: 'Gold · Copper · Molybdenum',          tickers: ['NEM','FCX','GFI'] },
  AZ: { resources: 'Oil · Natural Gas',                   tickers: ['XOM','CVX'] },
  IL: { resources: 'Technology · Offshore Gas',           tickers: ['TSM','NVDA','INTC'] },
  TR: { resources: 'Coal · Chrome · Boron',               tickers: ['NEM','COPX'] },
};

// ── Live Finnhub quote fetcher ─────────────────────────────────────────────────
async function fetchTickerQuotes(symbols) {
  const key = process.env.FINNHUB_KEY;
  if (!key || !symbols.length) return {};
  const results = {};
  await Promise.allSettled(
    symbols.map(async (sym) => {
      try {
        const res = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${key}`,
          { signal: AbortSignal.timeout(5000) },
        );
        if (!res.ok) return;
        const data = await res.json();
        if (typeof data.d === 'number') results[sym] = { d: data.d, dp: data.dp ?? 0 };
      } catch { /* ignore */ }
    }),
  );
  return results;
}

function formatAgo(tsSeconds) {
  if (!tsSeconds) return '';
  const h = Math.floor((Date.now() - tsSeconds * 1000) / 3600000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Discord webhook ───────────────────────────────────────────
let lastDiscordSendMs = 0;
const DISCORD_MIN_INTERVAL_MS = 1500; // max ~1 msg/1.5s to stay under rate limit

async function sendDiscord(title, body, url) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  // Enforce minimum interval between sends
  const now = Date.now();
  const elapsed = now - lastDiscordSendMs;
  if (elapsed < DISCORD_MIN_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, DISCORD_MIN_INTERVAL_MS - elapsed));
  }
  lastDiscordSendMs = Date.now();

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: `🚨 ${title}`,
          description: body || '',
          url: url || undefined,
          color: 0xff4444,
          footer: { text: 'WorldMonitor News Alert' },
          timestamp: new Date().toISOString(),
        }],
      }),
    });
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const retryAfter = (data.retry_after || 5) * 1000;
      console.warn(`[Discord] Rate limited — retry after ${data.retry_after || 5}s`);
      lastDiscordSendMs = Date.now() + retryAfter;
    }
  } catch (err) {
    console.warn('[Discord] Webhook failed:', err.message);
  }
}

async function sendDiscordPayload(payload) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;
  const now = Date.now();
  const elapsed = now - lastDiscordSendMs;
  if (elapsed < DISCORD_MIN_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, DISCORD_MIN_INTERVAL_MS - elapsed));
  }
  lastDiscordSendMs = Date.now();
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      lastDiscordSendMs = Date.now() + (data.retry_after || 5) * 1000;
      console.warn(`[Discord] Rate limited — retry after ${data.retry_after || 5}s`);
    }
  } catch (err) {
    console.warn('[Discord] Webhook failed:', err.message);
  }
}

// ── RSS polling loop ──────────────────────────────────────────
async function pollFeeds() {
  let discordSentThisCycle = 0;
  const DISCORD_MAX_PER_CYCLE = 3;

  for (const feedUrl of WATCH_FEEDS) {
    const items = await fetchFeed(feedUrl);
    for (const item of items) {
      if (seenIds.has(item.guid)) continue;
      markSeen(item.guid);

      if (!isBreaking(item.title)) continue;

      console.log(`[News] Breaking: ${item.title}`);

      const payload = {
        title: '🚨 Breaking News',
        body:  item.title,
        url:   item.link || '/',
        tag:   'wm-breaking',
        urgent: true,
      };

      void sendPushToAll(payload);

      if (discordSentThisCycle < DISCORD_MAX_PER_CYCLE) {
        discordSentThisCycle++;
        await sendDiscord(item.title, '', item.link);
      }
    }
  }
}

// ── Morning brief check (08:00 local server time) ────────────
let lastBriefDate = '';

async function buildMorningBriefEmbed() {
  const apiPort = process.env.API_SERVER_PORT || '3002';
  const base = `http://127.0.0.1:${apiPort}`;
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const [riskResult, newsResult] = await Promise.allSettled([
    fetch(`${base}/api/intelligence/v1/get-risk-scores?region=global`).then(r => r.json()),
    fetch(`${base}/api/news/v1/list-feed-digest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variant: 'full', lang: 'en' }),
    }).then(r => r.json()),
  ]);

  const fields = [];

  // Instability hotspots from ciiScores (per-country, already sorted descending)
  if (riskResult.status === 'fulfilled' && Array.isArray(riskResult.value?.ciiScores)) {
    const scores = riskResult.value.ciiScores
      .filter(s => s.combinedScore > 0)
      .slice(0, 5);

    if (scores.length) {
      // Collect unique tickers for all top countries, then fetch live quotes once
      const tickerSet = new Set();
      scores.forEach(s => {
        const cd = COUNTRY_COMMODITIES[s.region];
        if (cd) cd.tickers.forEach(t => tickerSet.add(t));
      });
      const quotes = await fetchTickerQuotes([...tickerSet]);

      const lines = scores.map(s => {
        const dot = s.combinedScore >= 80 ? '🔴' : s.combinedScore >= 60 ? '🟠' : '🟡';
        const flag = countryFlag(s.region);
        const name = COUNTRY_NAMES[s.region] || s.region;
        let line = `${dot} ${flag} **${name}** — **${s.combinedScore}**/100`;

        const cd = COUNTRY_COMMODITIES[s.region];
        if (cd) {
          line += `\n↳ ${cd.resources}`;
          const tickerStr = cd.tickers
            .map(t => {
              const q = quotes[t];
              if (!q) return t;
              return `${q.d >= 0 ? '↑' : '↓'} ${t} (${q.dp >= 0 ? '+' : ''}${q.dp.toFixed(1)}%)`;
            })
            .join(' · ');
          if (tickerStr) line += `\n↳ ${tickerStr}`;
        }

        return line;
      }).join('\n\n');
      fields.push({ name: '🌋 Instability Hotspots (Top 5)', value: lines.slice(0, 1020), inline: false });
    }
  }

  if (newsResult.status === 'fulfilled' && newsResult.value?.categories) {
    const cats = newsResult.value.categories;

    // ── Technology sector ──────────────────────────────────────────────────
    const techItems = [
      ...(Array.isArray(cats.tech?.items)  ? cats.tech.items  : []),
      ...(Array.isArray(cats.ai?.items)    ? cats.ai.items    : []),
    ].sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0)).slice(0, 3);

    if (techItems.length) {
      const lines = techItems.map(item => {
        const ago = formatAgo(item.publishedAt);
        const title = item.title.length > 80 ? item.title.slice(0, 77) + '…' : item.title;
        const link = item.link ? `[↗](${item.link})` : '';
        return `• **${title}** ${link}${ago ? ` *(${item.source}, ${ago})*` : ''}`;
      }).join('\n');
      fields.push({ name: '💻 Technology & AI', value: lines.slice(0, 1020), inline: false });
    }

    // ── Energy sector ──────────────────────────────────────────────────────
    const energyItems = (Array.isArray(cats.energy?.items) ? cats.energy.items : [])
      .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0)).slice(0, 3);

    if (energyItems.length) {
      const lines = energyItems.map(item => {
        const ago = formatAgo(item.publishedAt);
        const title = item.title.length > 80 ? item.title.slice(0, 77) + '…' : item.title;
        const link = item.link ? `[↗](${item.link})` : '';
        return `• **${title}** ${link}${ago ? ` *(${item.source}, ${ago})*` : ''}`;
      }).join('\n');
      fields.push({ name: '🛢 Energy', value: lines.slice(0, 1020), inline: false });
    }

    // ── Geopolitical & conflict news with links ────────────────────────────
    const geoItems = [
      ...(Array.isArray(cats.politics?.items)    ? cats.politics.items    : []),
      ...(Array.isArray(cats.middleeast?.items)  ? cats.middleeast.items  : []),
      ...(Array.isArray(cats.crisis?.items)      ? cats.crisis.items      : []),
      ...(Array.isArray(cats.africa?.items)      ? cats.africa.items      : []),
      ...(Array.isArray(cats.asia?.items)        ? cats.asia.items        : []),
    ]
      .filter(i => i.isAlert || (i.threat?.level && ['THREAT_LEVEL_CRITICAL','THREAT_LEVEL_HIGH'].includes(i.threat.level)))
      .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
      .slice(0, 6);

    if (geoItems.length) {
      const lines = geoItems.map(item => {
        const ago = formatAgo(item.publishedAt);
        const title = item.title.length > 85 ? item.title.slice(0, 82) + '…' : item.title;
        const link = item.link ? `[↗ Read](${item.link})` : '';
        return `🌍 **${title}**\n*${item.source}${ago ? `, ${ago}` : ''}* ${link}`;
      }).join('\n');
      fields.push({ name: '🌍 Geopolitical Alerts', value: lines.slice(0, 1020), inline: false });
    }
  }

  if (!fields.length) {
    fields.push({ name: 'ℹ️ Status', value: 'WorldMonitor API is live. Open the dashboard to view your full brief.', inline: false });
  }

  // ── Summary description ────────────────────────────────────────────────────
  const hotspotCount = fields.find(f => f.name.includes('Hotspot'))
    ? (riskResult.status === 'fulfilled' ? (riskResult.value?.ciiScores?.filter(s => s.combinedScore > 0).length || 0) : 0)
    : 0;
  const geoCount = fields.find(f => f.name.includes('Geopolitical'))?.value?.split('\n🌍').length - 1 || 0;
  const topHotspot = riskResult.status === 'fulfilled' && riskResult.value?.ciiScores?.[0]
    ? `${COUNTRY_NAMES[riskResult.value.ciiScores[0].region] || riskResult.value.ciiScores[0].region} (${riskResult.value.ciiScores[0].combinedScore}/100)`
    : null;

  const summaryParts = [];
  if (topHotspot) summaryParts.push(`Top instability hotspot: **${topHotspot}**`);
  if (geoCount > 0) summaryParts.push(`${geoCount} geopolitical alert${geoCount !== 1 ? 's' : ''}`);
  if (hotspotCount > 0) summaryParts.push(`${hotspotCount} instability hotspot${hotspotCount !== 1 ? 's' : ''} tracked`);
  const summaryText = summaryParts.length ? summaryParts.join(' · ') : 'Daily intelligence brief ready.';

  return {
    embeds: [{
      title: '📊 Morning Intelligence Brief',
      description: `**${dateStr}**\n${summaryText}`,
      color: 0x1a6b3a,
      fields,
      footer: { text: 'WorldMonitor Intelligence' },
      timestamp: now.toISOString(),
    }],
  };
}

async function checkMorningBrief() {
  const now   = new Date();
  const hour  = now.getHours();
  const today = now.toDateString();

  if (hour !== 8 || lastBriefDate === today) return;
  lastBriefDate = today;

  // Push notification
  void sendPushToAll({
    title: '📊 Morning Intelligence Brief Ready',
    body:  'Your daily brief is ready — open WorldMonitor.',
    url:   '/',
    tag:   'wm-morning-brief',
    urgent: false,
  });

  // Rich Discord embed
  if (process.env.DISCORD_WEBHOOK_URL) {
    try {
      const payload = await buildMorningBriefEmbed();
      void sendDiscordPayload(payload);
    } catch (err) {
      console.warn('[Discord] Morning brief build failed:', err.message);
      void sendDiscord('Morning Intelligence Brief', 'Your daily brief is ready — open WorldMonitor.', '/');
    }
  }
}

// ── Public API ────────────────────────────────────────────────
function init() {
  vapidKeys = loadOrGenerateVapidKeys();
  loadSeenIds();

  webpush.setVapidDetails(
    'mailto:' + (process.env.VAPID_EMAIL || 'admin@costo.eu'),
    vapidKeys.publicKey,
    vapidKeys.privateKey,
  );

  // Poll every 5 minutes
  setInterval(() => { void pollFeeds(); }, 5 * 60 * 1000);

  // Check for morning brief every minute
  setInterval(checkMorningBrief, 60 * 1000);

  // Initial poll after 10s (let server warm up)
  setTimeout(() => { void pollFeeds(); }, 10 * 1000);

  console.log('  🔔 Push service started');
}

function getVapidPublicKey() {
  return vapidKeys?.publicKey ?? null;
}

async function triggerMorningBrief() {
  void sendPushToAll({
    title: '📊 Morning Intelligence Brief Ready',
    body:  'Your daily brief is ready — open WorldMonitor.',
    url:   '/',
    tag:   'wm-morning-brief',
    urgent: false,
  });
  if (process.env.DISCORD_WEBHOOK_URL) {
    const payload = await buildMorningBriefEmbed();
    await sendDiscordPayload(payload);
  }
}

module.exports = {
  init,
  getVapidPublicKey,
  addSubscription,
  removeSubscription,
  triggerMorningBrief,
};
