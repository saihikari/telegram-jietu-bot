#!/bin/bash
set -e

echo "=========================================="
echo "部署截图机器人 (Node.js) 到 /root/telegram-jietu-bot/"
echo "=========================================="

# 1. 手动编译安装/二进制包安装 Node.js 20.x (彻底绕过 NodeSource)
echo "正在检测/安装 Node.js 20.x..."
if ! command -v node &> /dev/null; then
    NODE_VERSION="v20.12.2"
    NODE_DIST="node-${NODE_VERSION}-linux-x64"
    cd /tmp
    wget https://nodejs.org/dist/${NODE_VERSION}/${NODE_DIST}.tar.xz
    tar -xvf ${NODE_DIST}.tar.xz
    cp -r ${NODE_DIST}/* /usr/local/
    rm -rf ${NODE_DIST} ${NODE_DIST}.tar.xz
    echo "Node.js 20.x 安装成功！版本："
    node -v
else
    echo "检测到 Node.js 已安装，版本："
    node -v
fi

# 2. 安装 pnpm
npm install -g pnpm

# 3. 切换回应用目录
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
ExecStart=/usr/local/bin/pnpm start
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PATH=/usr/local/bin:/usr/bin:/bin

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
