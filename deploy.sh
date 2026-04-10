#!/bin/bash
set -e

echo "=========================================="
echo "部署截图机器人 (Node.js) 到 /root/telegram-jietu-bot/"
echo "=========================================="

# 1. 安装 Node.js 20.x
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs

# 2. 安装 pnpm
npm install -g pnpm

# 3. 创建应用目录
mkdir -p /root/telegram-jietu-bot
cd /root/telegram-jietu-bot

# 4. 复制代码
# 这里假设您已经将代码上传到了 /root/telegram-jietu-bot，或者通过 git clone 获取
# 如果使用 git: git clone <repo> .

# 5. 安装依赖
pnpm install

# 6. 创建 .env 文件（如果不存在）
if [ ! -f .env ]; then
cat > .env <<EOF
BOT_TOKEN=your_bot_token_here
MONITOR_CHAT_IDS=-1001234567890
WEB_PORT=8070
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$(openssl rand -base64 12)
LLM_API_KEY=sk-xxx
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
IDLE_TIMEOUT_SECONDS=10
LOG_LEVEL=info
EOF

echo "已生成默认 .env 文件，随机管理员密码已生成，请记录："
grep ADMIN_PASSWORD .env
fi

# 7. 编译 TypeScript 代码
pnpm run build

# 8. 创建 systemd 服务
cat > /etc/systemd/system/telegram-jietu-bot.service <<EOF
[Unit]
Description=Telegram Laibao Bot (Node.js)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/telegram-jietu-bot
ExecStart=/usr/bin/pnpm start
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable telegram-jietu-bot

# 9. 开放防火墙端口 (如果使用 firewalld)
if command -v firewall-cmd &> /dev/null; then
    firewall-cmd --permanent --add-port=8070/tcp
    firewall-cmd --reload
fi

# 10. 启动服务
systemctl start telegram-jietu-bot

echo "部署完成！"
systemctl status telegram-jietu-bot --no-pager
echo "管理界面：http://<服务器IP>:8070/admin/config"
echo "状态页面：http://<服务器IP>:8070/admin/status"
