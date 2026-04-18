#!/bin/bash
cd /root/telegram-jietu-bot
git stash
git fetch --all
git reset --hard origin/main
pnpm install
pnpm run build
sudo systemctl restart telegram-jietu-bot
