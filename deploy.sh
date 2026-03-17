#!/bin/bash
# ── OpenClaw Platform — Deploy Script ───────────────────────────
# Run on the Hetzner server: bash deploy.sh

set -e

echo ""
echo "🚀 Deploying OpenClaw Platform..."
echo ""

# Pull latest code
git pull origin main

# Install root dependencies
echo "📦 Installing server dependencies..."
npm install

# Install & build WorldMonitor
echo "🌍 Installing WorldMonitor dependencies..."
cd worldmonitor && npm install

echo "🔨 Building WorldMonitor..."
cd ..
node scripts/build-wm.js

# Restart OpenClaw Terminal via PM2
echo "⚡ Restarting OpenClaw Terminal..."
pm2 restart openclaw 2>/dev/null || pm2 start server.js --name openclaw

pm2 save

echo ""
echo "✅ Deploy complete!"
echo "   OpenClaw Terminal  →  http://localhost:3001"
echo "   WorldMonitor       →  http://localhost:3000"
echo ""
