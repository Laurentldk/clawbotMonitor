# OpenClaw Platform — Deployment Guide

Full instructions for deploying the OpenClaw Intelligence Terminal + WorldMonitor on a Hetzner Cloud VPS.

---

## Architecture

```
Hetzner VPS (Ubuntu 24.04)
├── node server.js
│   ├── OpenClaw Terminal   → port 3001
│   └── WorldMonitor        → port 3000
└── nginx (reverse proxy)
    ├── yourdomain.com       → port 3000 (WorldMonitor, main dashboard)
    └── terminal.yourdomain.com  → port 3001 (OpenClaw Terminal)
```

---

## Step 1 — Create a Hetzner VPS

1. Go to [console.hetzner.cloud](https://console.hetzner.cloud)
2. Create a new project
3. Click **Add Server** with these settings:
   - **Location:** Falkenstein or Helsinki (closest to Brussels)
   - **OS:** Ubuntu 24.04
   - **Type:** CX22 (2 vCPU, 4 GB RAM — ~€4.35/month)
   - **SSH Key:** add your public key (`~/.ssh/id_rsa.pub`)
4. Note the server's **public IP address** (e.g. `65.21.x.x`)

---

## Step 2 — Connect to the Server

```bash
ssh root@YOUR_SERVER_IP
```

---

## Step 3 — Install Required Software

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# nginx + certbot (for HTTPS)
apt install -y nginx certbot python3-certbot-nginx

# PM2 (keeps Node processes alive across reboots)
npm install -g pm2
```

Verify versions:
```bash
node -v    # should be v22.x
npm -v
pm2 -v
nginx -v
```

---

## Step 4 — Clone the Repository

```bash
git clone https://github.com/Laurentldk/clawbotMonitor.git /var/www/openclaw
cd /var/www/openclaw
```

---

## Step 5 — Configure Environment Variables

```bash
cp .env.example .env
nano .env
```

Fill in your real values:
```env
FINNHUB_KEY=your_real_finnhub_api_key
MASSIVE_KEY=your_real_massive_api_key
PORT=3001
PORT_WM=3000
```

Save with `Ctrl+X` → `Y` → `Enter`.

> **.env is never committed to git — only you set it on the server.**

---

## Step 6 — Run the Deploy Script

```bash
bash deploy.sh
```

This will:
1. Install root Node dependencies
2. Install WorldMonitor dependencies
3. Build WorldMonitor (takes ~2 minutes)
4. Start/restart OpenClaw Terminal via PM2
5. Save the PM2 process list

You should see:
```
✅ Deploy complete!
   OpenClaw Terminal  →  http://localhost:3001
   WorldMonitor       →  http://localhost:3000
```

---

## Step 7 — Enable PM2 on Reboot

```bash
pm2 startup
# Copy and run the command it outputs, then:
pm2 save
```

This ensures both apps restart automatically if the server reboots.

---

## Step 8 — Configure nginx

### Option A — Using IP address only (no domain)

```bash
nano /etc/nginx/sites-available/openclaw
```

Paste:
```nginx
# WorldMonitor — main dashboard
server {
    listen 80 default_server;
    server_name _;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}

# OpenClaw Terminal — on port 8080
server {
    listen 8080;
    server_name _;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### Option B — Using a custom domain (recommended)

Point your domain DNS `A records` to the Hetzner IP:
- `yourdomain.com` → `YOUR_SERVER_IP`
- `terminal.yourdomain.com` → `YOUR_SERVER_IP`

Then:
```bash
nano /etc/nginx/sites-available/openclaw
```

Paste:
```nginx
# WorldMonitor — main dashboard
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}

# OpenClaw Intelligence Terminal
server {
    listen 80;
    server_name terminal.yourdomain.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### Enable the config

```bash
ln -s /etc/nginx/sites-available/openclaw /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

---

## Step 9 — Enable HTTPS (domain only)

```bash
certbot --nginx -d yourdomain.com -d www.yourdomain.com -d terminal.yourdomain.com
```

Follow the prompts. Certbot automatically:
- Obtains free SSL certificates from Let's Encrypt
- Updates nginx config to redirect HTTP → HTTPS
- Sets up auto-renewal

Verify auto-renewal works:
```bash
certbot renew --dry-run
```

---

## Step 10 — Open Firewall Ports

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw allow 8080   # only if using IP-based setup (Option A)
ufw enable
```

---

## Verify Everything is Running

```bash
pm2 status              # both apps should show "online"
systemctl status nginx  # should show "active (running)"
curl http://localhost:3001/api/health  # should return {"status":"ok"}
curl http://localhost:3000             # should return WorldMonitor HTML
```

---

## Deploying Updates

Every time you push changes to GitHub, deploy them on the server with one command:

```bash
cd /var/www/openclaw && bash deploy.sh
```

This pulls the latest code, rebuilds WorldMonitor if needed, and restarts the server.

---

## Useful PM2 Commands

```bash
pm2 status              # show running processes
pm2 logs openclaw       # live logs for OpenClaw Terminal
pm2 restart openclaw    # restart the server
pm2 stop openclaw       # stop the server
pm2 delete openclaw     # remove from PM2
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Port already in use | `pm2 restart openclaw` or `pm2 delete openclaw && pm2 start server.js --name openclaw` |
| WorldMonitor shows blank | Run `bash deploy.sh` to rebuild |
| nginx 502 Bad Gateway | Check `pm2 status` — app may have crashed. Check `pm2 logs openclaw` |
| HTTPS not working | Check DNS has propagated: `nslookup yourdomain.com` |
| App not starting after reboot | Run `pm2 startup` and `pm2 save` again |

---

## File Structure

```
/var/www/openclaw/
├── server.js           ← starts both apps
├── package.json
├── .env                ← API keys (never in git)
├── .env.example        ← key template
├── deploy.sh           ← deployment script
├── scripts/
│   └── build-wm.js     ← WorldMonitor build helper
├── public/             ← OpenClaw Terminal (static HTML)
└── worldmonitor/       ← WorldMonitor source + dist/
    └── dist/           ← built by deploy.sh
```
