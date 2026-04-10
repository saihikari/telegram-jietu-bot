#!/bin/bash
set -e

echo "=========================================="
echo "部署截图机器人 (Node.js) 到 /root/telegram-jietu-bot/"
echo "=========================================="

# 1. 安装 Node.js 20.x (强制使用通用兼容方式，避免 NodeSource 脚本的误判)
echo "正在安装 Node.js 20.x..."
if command -v dnf &> /dev/null; then
    dnf module install -y nodejs:20 || (curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && dnf install -y nodejs)
elif command -v yum &> /dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && yum install -y nodejs
elif command -v apt-get &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs
else
    echo "未能检测到受支持的包管理器 (dnf/yum/apt-get)。"
    exit 1
fi

# 2. 安装 pnpm
npm install -g pnpm

# 3. 创建应用目录
mkdir -p /root/telegram-jietu-bot
cd /root/telegram-jietu-bot

# 4. 安装依赖
pnpm install

# 5. 创建 .env 文件（如果不存在）
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

# 6. 编译 TypeScript 代码
pnpm run build

# 7. 创建 systemd 服务
cat > /etc/systemd/system/telegram-jietu-bot.service <<EOF
[Unit]
Description=Telegram Jietu Bot (Node.js)
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

# 8. 开放防火墙端口
if command -v ufw &> /dev/null; then
    ufw allow 8070/tcp
elif command -v firewall-cmd &> /dev/null; then
    firewall-cmd --permanent --add-port=8070/tcp
    firewall-cmd --reload
fi

# 9. 启动服务
systemctl start telegram-jietu-bot

echo "部署完成！"
systemctl status telegram-jietu-bot --no-pager
echo "管理界面：http://<服务器IP>:8070/admin/config"
echo "状态页面：http://<服务器IP>:8070/admin/status"
