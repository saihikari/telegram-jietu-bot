#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${DOMAIN:-jietu.runtoads.top}"
EMAIL="${EMAIL:-you@runtoads.top}"
UPSTREAM_HOST="${UPSTREAM_HOST:-127.0.0.1}"
UPSTREAM_PORT="${UPSTREAM_PORT:-8070}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root"
  exit 1
fi

if [[ -z "${DOMAIN}" || -z "${EMAIL}" ]]; then
  echo "Missing DOMAIN or EMAIL"
  exit 1
fi

install_pkgs() {
  if command -v nginx >/dev/null 2>&1 && command -v certbot >/dev/null 2>&1; then
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y nginx certbot python3-certbot-nginx
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    dnf install -y epel-release || true
    dnf install -y nginx || true
    dnf install -y nginx-core || true
    dnf install -y certbot python3-certbot-nginx || true
    return
  fi

  if command -v yum >/dev/null 2>&1; then
    yum install -y epel-release || true
    yum install -y nginx || true
    yum install -y nginx-core || true
    yum install -y certbot python3-certbot-nginx || true
    return
  fi

  echo "No supported package manager found (apt-get/dnf/yum)"
  exit 1
}

install_pkgs

if ! command -v nginx >/dev/null 2>&1; then
  echo "nginx not found. Please install nginx first (it may be excluded by repo filtering)."
  exit 1
fi

if ! command -v certbot >/dev/null 2>&1; then
  echo "certbot not found. Please install certbot first."
  exit 1
fi

systemctl enable --now nginx

NGINX_CONF_PATH="/etc/nginx/conf.d/${DOMAIN}.conf"
cat > "${NGINX_CONF_PATH}" <<EOF
server {
  listen 80;
  server_name ${DOMAIN};
  location /.well-known/acme-challenge/ { root /var/www/html; }
  location / { return 301 https://\\\$host\\\$request_uri; }
}

server {
  listen 443 ssl http2;
  server_name ${DOMAIN};

  ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;

  gzip on;
  gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;

  location / {
    proxy_pass http://${UPSTREAM_HOST}:${UPSTREAM_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \\$host;
    proxy_set_header X-Real-IP \\$remote_addr;
    proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \\$scheme;
  }
}
EOF

nginx -t
systemctl reload nginx

certbot --nginx -d "${DOMAIN}" -m "${EMAIL}" --agree-tos --non-interactive --redirect
systemctl enable --now certbot.timer || true

echo "OK"
echo "WebApp entry: https://${DOMAIN}/admin/"
