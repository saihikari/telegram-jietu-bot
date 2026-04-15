## 目标

- 统一入口：`https://jietu.runtoads.top/admin/`
- Telegram 内打开：Telegram WebApp initData 校验 + 白名单登录
- 外部浏览器打开：用户名/密码登录 + Cookie 会话
- Portal 统一后台：同一套 WebApp 中同时管理截图机器人与日报机器人（状态/配置/帮助）

## 项目结构（关键）

- Admin WebApp 前端入口： [public/index.html](file:///workspace/public/index.html)
- 后台路由与鉴权： [web-admin.ts](file:///workspace/src/bot/web-admin.ts)
- Web 服务入口： [index.ts](file:///workspace/src/index.ts)

## 关键接口与路由

**页面**
- `GET /admin/login` 外部登录页（Telegram 内会自动走 tg-login）
- `GET /admin/` Portal WebApp 入口（需登录）
- `GET /admin/config` Portal Tab（需登录）
- `GET /admin/status` Portal Tab（需登录）
- `GET /admin/guide` Portal Tab（需登录）
- `GET /admin/logout` 清 Cookie 并回到登录页

**鉴权**
- `POST /api/tg-login` `{ initData }`：校验 `initData.hash`（用 `BOT_TOKEN`），并检查 `.env` 的 `ADMIN_TG_IDS`
- `POST /api/login` 表单登录（用户名/密码），写 Cookie
- `POST /api/logout` 清 Cookie

**Portal 数据接口（均需登录）**
- `GET /api/status`：返回 `{ screenshot: botStats, report: <日报 status> }`
- `GET /api/config?target=screenshot|report`
- `POST /api/config?target=screenshot|report`
- `POST /api/config/backup?target=screenshot|report`
- `GET /api/default-prompt`

## Telegram WebApp initData 校验

- 后端按官方流程做 HMAC 校验：
  - `secretKey = HMAC_SHA256("WebAppData", BOT_TOKEN)`
  - `hash = HMAC_SHA256(secretKey, data_check_string)`
- 只从 `initData.user.id` 取 TG 数字 ID
- 日志不打印 `BOT_TOKEN` / `initData` 全量

## Cookie / Session 注意事项（已规避）

- HTTPS 下 Cookie 自动带：`SameSite=None; Secure; HttpOnly`
- iOS/Telegram WebView 可能出现“写 Cookie 失败导致登录循环”：
  - `sessionStorage` 做了一次性跳转标记兜底
  - 若仍循环，可在 `/admin/login` 页面手动账号密码登录

## 必要环境变量清单（截图机器人）

```bash
BOT_TOKEN=xxxxxxxx
WEB_PORT=8070
WEB_DOMAIN=https://jietu.runtoads.top

ADMIN_TG_IDS=8413696128,7746892135
ADMIN_USERNAME=admin
ADMIN_PASSWORD=请设置强密码
ADMIN_COOKIE_SECURE=true
ADMIN_SESSION_SECRET=可选（不填则复用 ADMIN_PASSWORD）

REPORT_BOT_INTERNAL_BASE_URL=http://127.0.0.1:8060
```

## 必要环境变量清单（日报机器人）

```bash
PORT=8060
WEB_BIND=127.0.0.1
ADMIN_USERNAME=admin
ADMIN_PASSWORD=建议与截图后台不同
```

Portal 调用日报机器人接口走内网 `127.0.0.1`，不要求日报机器人对外 HTTPS。

## Nginx 反向代理（443 -> Node）

示例（精简版，可直接放到 `/etc/nginx/sites-available/jietu.runtoads.top`）：

```nginx
server {
  listen 80;
  server_name jietu.runtoads.top;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  server_name jietu.runtoads.top;

  ssl_certificate /etc/letsencrypt/live/jietu.runtoads.top/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/jietu.runtoads.top/privkey.pem;

  gzip on;
  gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;

  location / {
    proxy_pass http://127.0.0.1:8070;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## Certbot 申请证书与自动续签

```bash
apt-get update
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d jietu.runtoads.top --non-interactive --agree-tos -m you@runtoads.top
systemctl enable --now certbot.timer
```

## systemd 建议（截图机器人）

示例：`/etc/systemd/system/telegram-jietu-bot.service`

```ini
[Unit]
Description=telegram-jietu-bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/root/telegram-jietu-bot
EnvironmentFile=/root/telegram-jietu-bot/.env
ExecStart=/usr/bin/node /root/telegram-jietu-bot/dist/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now telegram-jietu-bot
```

## 踩坑清单（高频）

- Telegram WebApp 必须使用 HTTPS 域名访问，不能 `http://IP:端口`
- 证书必须与域名匹配，否则手机端会 `ERR_CERT_COMMON_NAME_INVALID`
- iOS WebView Cookie 更严格，必须 `SameSite=None; Secure; HttpOnly`
- 避免前端直接访问 `http://127.0.0.1:8060/...`（HTTPS Mixed Content 会被拦截），必须走 Portal 的同域 `/api/*`

