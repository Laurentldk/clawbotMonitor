# OpenClaw Platform — Deployment Guide

Step-by-step instructions to deploy the OpenClaw Intelligence Terminal + WorldMonitor on **Hostinger VPS** with a custom domain from **Combell** (costo.eu).

---

## Architecture

```
Hostinger VPS (Ubuntu 24.04)
├── node server.js
│   ├── WorldMonitor        → port 3000
│   └── OpenClaw Terminal   → port 3001
└── nginx (reverse proxy + HTTPS)
    ├── costo.eu                  → WorldMonitor (main dashboard)
    └── terminal.costo.eu         → OpenClaw Intelligence Terminal
```

---

## Step 1 — Create a Hostinger VPS

1. Go to [hostinger.com/vps-hosting](https://www.hostinger.com/vps-hosting)
2. Choose **KVM 2** plan (~$6.99/month — 2 vCPU, 8 GB RAM) — recommended for smooth WorldMonitor build
3. During checkout/setup:
   - **OS:** Ubuntu 24.04
   - **Region:** Frankfurt (closest to Brussels)
4. Once the VPS is created, go to **hPanel → VPS → Manage**
5. Note your **VPS IP address** (shown on the overview page)
6. Under **SSH Access**, either:
   - Set a **root password**, or
   - Add your SSH public key

> You can also use the built-in **Browser Terminal** in hPanel → VPS → Manage → Terminal
> instead of installing an SSH client.

---

## Step 2 — Point Your Combell Domain to Hostinger

You need to create DNS records so `costo.eu` and `terminal.costo.eu` point to your VPS.

1. Log in at [my.combell.com](https://my.combell.com/nl/product/dns/overview/costo.eu)
2. Go to **DNS → Overview → costo.eu**
3. Click **Add record** and add the following:

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | `@` | `YOUR_VPS_IP` | 3600 |
| A | `www` | `YOUR_VPS_IP` | 3600 |
| A | `terminal` | `YOUR_VPS_IP` | 3600 |

> Replace `YOUR_VPS_IP` with the IP address from your Hostinger VPS overview.

4. Click **Save** for each record

> DNS changes take **5–30 minutes** to propagate. You can verify with:
> `nslookup costo.eu` — it should return your VPS IP.

---

## Step 3 — Connect to the Server

Open a terminal (or use hPanel Browser Terminal) and run:

```bash
ssh root@YOUR_VPS_IP
```

Enter your password when prompted.

---

## Step 4 — Install Required Software

Run these commands one by one on the server:

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Install nginx and certbot (HTTPS)
apt install -y nginx certbot python3-certbot-nginx

# Install PM2 (keeps Node running after reboot)
npm install -g pm2

# Install git
apt install -y git
```

Verify everything installed correctly:
```bash
node -v    # v22.x.x
npm -v
pm2 -v
nginx -v
```

---

## Step 5 — Clone the Repository

```bash
git clone https://github.com/Laurentldk/clawbotMonitor.git /var/www/openclaw
cd /var/www/openclaw
```

---

## Step 6 — Configure Environment Variables

```bash
cp .env.example .env
nano .env
```

Fill in your real API keys:
```env
FINNHUB_KEY=your_real_finnhub_api_key
MASSIVE_KEY=your_real_massive_api_key
PORT=3001
PORT_WM=3000
```

Save: press `Ctrl+X` → `Y` → `Enter`

> `.env` is never committed to GitHub — only you set it on the server.

---

## Step 7 — Deploy the Application

```bash
bash deploy.sh
```

This will:
1. Install root dependencies (`npm install`)
2. Install WorldMonitor dependencies
3. Build WorldMonitor with Vite (~2 minutes)
4. Start both servers via PM2

Expected output:
```
✅ Deploy complete!
   OpenClaw Terminal  →  http://localhost:3001
   WorldMonitor       →  http://localhost:3000
```

---

## Step 8 — Enable PM2 on Reboot

```bash
pm2 startup
```

Copy and run the command it outputs (starts with `sudo env PATH=...`), then:

```bash
pm2 save
```

Both apps will now restart automatically if the server reboots.

---

## Step 9 — Configure nginx

```bash
nano /etc/nginx/sites-available/openclaw
```

Paste the following (replace `costo.eu` if you use a different domain):

```nginx
# WorldMonitor — main dashboard
server {
    listen 80;
    server_name costo.eu www.costo.eu;

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
    server_name terminal.costo.eu;

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

Save: `Ctrl+X` → `Y` → `Enter`

Enable the config and reload nginx:

```bash
ln -s /etc/nginx/sites-available/openclaw /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

---

## Step 10 — Enable HTTPS with Let's Encrypt

> Make sure DNS has propagated before this step (`nslookup costo.eu` returns your VPS IP).

```bash
certbot --nginx -d costo.eu -d www.costo.eu -d terminal.costo.eu
```

Follow the prompts:
- Enter your email address
- Agree to terms of service (A)
- Choose whether to share email with EFF (optional)

Certbot automatically:
- Obtains free SSL certificates
- Updates nginx to redirect HTTP → HTTPS
- Sets up auto-renewal every 90 days

Verify auto-renewal:
```bash
certbot renew --dry-run
```

---

## Step 11 — Open Firewall

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```

---

## Final Verification

```bash
# Check both apps are running
pm2 status

# Check nginx is running
systemctl status nginx

# Test API
curl http://localhost:3001/api/health
# Expected: {"status":"ok","time":"..."}

# Test WorldMonitor
curl -I http://localhost:3000
# Expected: HTTP/1.1 200 OK
```

Then open in your browser:
- `https://costo.eu` — WorldMonitor main dashboard
- `https://terminal.costo.eu` — OpenClaw Intelligence Terminal

---

## Deploying Future Updates

Every time you push changes to GitHub, deploy them on the server with:

```bash
cd /var/www/openclaw && bash deploy.sh
```

---

## Useful Commands

```bash
# PM2
pm2 status                  # show running processes
pm2 logs openclaw           # live logs
pm2 restart openclaw        # restart after config change
pm2 stop openclaw           # stop

# nginx
nginx -t                    # test config syntax
systemctl reload nginx      # apply config changes
systemctl status nginx      # check if running

# Certbot
certbot renew               # manually renew certificates
certbot certificates        # list certificates
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `ssh: connection refused` | Wait 2–3 min after VPS creation, then retry |
| `costo.eu` not loading | DNS not propagated yet — wait 10–30 min and retry |
| nginx `502 Bad Gateway` | `pm2 status` — app crashed. Check `pm2 logs openclaw` |
| WorldMonitor shows blank page | Re-run `bash deploy.sh` to rebuild |
| HTTPS certificate error | Ensure DNS is set correctly, then re-run `certbot --nginx ...` |
| Port already in use | `pm2 restart openclaw` |
| App not running after reboot | Run `pm2 startup` + `pm2 save` |

---

## File Structure on Server

```
/var/www/openclaw/
├── server.js              ← starts both apps (ports 3000 + 3001)
├── package.json
├── .env                   ← API keys (never in git — set manually)
├── .env.example           ← key template
├── deploy.sh              ← one-command deploy script
├── DEPLOYMENT.md          ← this file
├── scripts/
│   └── build-wm.js        ← WorldMonitor build helper
├── public/                ← OpenClaw Terminal static files
└── worldmonitor/
    ├── src/               ← WorldMonitor source
    └── dist/              ← built output (served on port 3000)
```
