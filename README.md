# 💎 Golden Tap — Real-Time Server

Socket.IO real-time server for Golden Tap gaming platform.

## Deploy to Render.com

1. Push this repo to GitHub (these 3 files at root level)
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect this repo
4. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Root Directory:** *(leave completely blank)*

## Environment Variables (add in Render dashboard)

| Key | Value |
|-----|-------|
| PORT | 3000 |
| NODE_ENV | production |
| CLIENT_ORIGIN | https://g.tap.t-lyfe.com.ng |
| JWT_SECRET | gt_jwt_32char_secret_key_production_change! |
| INTERNAL_API_KEY | gt_internal_key_change_this_in_prod |
| PHP_API_BASE | https://g.tap.t-lyfe.com.ng/backend |

## After Deploy

Copy your Render URL and update `SOCKET_URL` in:
- `home.html`
- `game.html`
- `dashboard.html`
- `chat.html`
- `backend/config.php` → `SOCKET_SERVER_URL`
