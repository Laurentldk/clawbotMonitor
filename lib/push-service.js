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

  // Instability hotspots from strategicRisks
  if (riskResult.status === 'fulfilled' && Array.isArray(riskResult.value?.strategicRisks)) {
    const risks = riskResult.value.strategicRisks
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    if (risks.length) {
      const lines = risks.map(r => {
        const dot = r.score >= 80 ? '🔴' : r.score >= 60 ? '🟠' : '🟡';
        const flag = countryFlag(r.region);
        const name = COUNTRY_NAMES[r.region] || r.region;
        const factors = (r.factors || []).slice(0, 3).join(' · ');
        return `${dot} ${flag} **${name}** — **${r.score}**/100${factors ? `\n  ↳ ${factors}` : ''}`;
      }).join('\n');
      fields.push({ name: '🌋 Instability Hotspots', value: lines.slice(0, 1020), inline: false });
    }
  }

  // Geopolitical & conflict news
  if (newsResult.status === 'fulfilled' && newsResult.value?.categories) {
    const cats = newsResult.value.categories;
    const geoKeys = ['geopolitical', 'conflict', 'military', 'diplomatic', 'defense'];
    const items = [];
    for (const key of geoKeys) {
      if (Array.isArray(cats[key]?.items)) items.push(...cats[key].items);
    }
    const top = items
      .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
      .slice(0, 6);

    if (top.length) {
      const lines = top.map(item => {
        const ago = formatAgo(item.publishedAt);
        const title = item.title.length > 90 ? item.title.slice(0, 87) + '…' : item.title;
        return `• **${title}**${ago ? ` *(${item.source}, ${ago})*` : ''}`;
      }).join('\n');
      fields.push({ name: '🌍 Geopolitical Alerts', value: lines.slice(0, 1020), inline: false });
    }
  }

  if (!fields.length) {
    fields.push({ name: 'ℹ️ Status', value: 'WorldMonitor API is live. Open the dashboard to view your full brief.', inline: false });
  }

  return {
    embeds: [{
      title: '📊 Morning Intelligence Brief',
      description: `**${dateStr}**`,
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

module.exports = {
  init,
  getVapidPublicKey,
  addSubscription,
  removeSubscription,
};
