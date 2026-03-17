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

// ── Discord webhook ───────────────────────────────────────────
async function sendDiscord(title, body, url) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    await fetch(webhookUrl, {
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
  } catch (err) {
    console.warn('[Discord] Webhook failed:', err.message);
  }
}

// ── RSS polling loop ──────────────────────────────────────────
async function pollFeeds() {
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

      // Fire push + Discord in parallel
      void sendPushToAll(payload);
      void sendDiscord(item.title, '', item.link);
    }
  }
}

// ── Morning brief check (08:00 local server time) ────────────
let lastBriefDate = '';

function checkMorningBrief() {
  const now   = new Date();
  const hour  = now.getHours();
  const today = now.toDateString();

  if (hour !== 8 || lastBriefDate === today) return;
  lastBriefDate = today;

  const payload = {
    title: '📊 Morning Market Brief Ready',
    body:  'Your daily market brief is available — open WorldMonitor to read it.',
    url:   '/',
    tag:   'wm-morning-brief',
    urgent: false,
  };

  void sendPushToAll(payload);

  if (process.env.DISCORD_WEBHOOK_URL) {
    void sendDiscord('Morning Market Brief', payload.body, '/');
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
