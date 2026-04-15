import dotenv from 'dotenv';
import path from 'path';

// 加载 .env 环境变量
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import express from 'express';
import { adminRouter, apiRouter } from './bot/web-admin';
import { BotApp } from './bot/telegram-bot';
import logger from './utils/logger';
import { loadSettings } from './utils/config';

// 确保目录存在
const fs = require('fs');
['../temp', '../logs', '../config/backups'].forEach(dir => {
  const fullPath = path.resolve(__dirname, dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
});

// 1. 加载配置
loadSettings();

// 2. 启动 Express 服务器
const app = express();
const port = process.env.WEB_PORT || 8070;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.set('trust proxy', 1);
app.use('/admin', adminRouter);
app.use('/api', apiRouter);
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(port, () => {
  logger.info(`Web Admin server listening on port ${port}`);
});

// 3. 启动 Telegram Bot
try {
  new BotApp();
} catch (error) {
  logger.error('Failed to start Telegram Bot:', error);
}

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
