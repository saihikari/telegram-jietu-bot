import TelegramBot from 'node-telegram-bot-api';
import path from 'path';
import fs from 'fs';
import { ImageQueue } from './image-queue';
import { ImageProcessor } from './image-processor';
import { ExcelGenerator } from './excel-generator';
import { ImageTask } from '../types';
import { getSettings } from '../utils/config';
import logger from '../utils/logger';
import { botStats } from './web-admin';

export class BotApp {
  private bot: TelegramBot;
  private queues: Map<number, ImageQueue> = new Map();
  private processor: ImageProcessor;
  private excelGen: ExcelGenerator;
  private allowedChatIds: number[];

  constructor() {
    const token = process.env.BOT_TOKEN;
    if (!token) {
      throw new Error('BOT_TOKEN is missing in environment variables');
    }
    
    this.allowedChatIds = (process.env.MONITOR_CHAT_IDS || '')
      .split(',')
      .map(id => parseInt(id.trim()))
      .filter(id => !isNaN(id));

    this.bot = new TelegramBot(token, { polling: true });
    this.processor = new ImageProcessor();
    this.excelGen = new ExcelGenerator();

    this.setupListeners();
    logger.info('Telegram Bot initialized and started polling.');
  }

  private setupListeners() {
    this.bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      
      // Ignore messages from non-monitored chats unless it's a command like /id
      if (!this.allowedChatIds.includes(chatId)) {
        if (msg.text === '/id') {
          this.bot.sendMessage(chatId, `Chat ID: \`${chatId}\``, { parse_mode: 'Markdown' });
        }
        return;
      }

      if (msg.photo && msg.photo.length > 0) {
        this.handlePhoto(msg);
      } else if (msg.text) {
        this.handleCommand(msg);
      }
    });

    this.bot.on('polling_error', (error: any) => {
      // Avoid printing full stack trace for known network errors to reduce log noise
      if (error.code === 'EFATAL' || error.message?.includes('network')) {
        logger.error(`Telegram Polling Network Error: ${error.message || error.code}`);
      } else {
        logger.error('Telegram Polling Error:', error);
      }
    });
  }

  private getQueue(chatId: number): ImageQueue {
    if (!this.queues.has(chatId)) {
      const queue = new ImageQueue(chatId);
      queue.on('process', (tasks: ImageTask[]) => this.processTasks(chatId, tasks));
      this.queues.set(chatId, queue);
    }
    return this.queues.get(chatId)!;
  }

  private async handlePhoto(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    // Get the highest resolution photo
    const photo = msg.photo![msg.photo!.length - 1];
    
    const task: ImageTask = {
      message_id: msg.message_id,
      file_id: photo.file_id,
      chat_id: chatId,
      timestamp: msg.date,
      status: 'pending'
    };

    const queue = this.getQueue(chatId);
    queue.addTask(task);
    
    botStats.queueLength++;
  }

  private async handleCommand(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const text = msg.text || '';

    if (text.startsWith('/id')) {
      this.bot.sendMessage(chatId, `Chat ID: \`${chatId}\``, { parse_mode: 'Markdown' });
    } else if (text.startsWith('/test')) {
      this.bot.sendMessage(chatId, '✅ 机器人运行正常');
    } else if (text.startsWith('/help')) {
      const port = process.env.WEB_PORT || 8070;
      const host = process.env.HOST || 'http://localhost';
      const url = `${host}:${port}/admin/guide`;
      this.bot.sendMessage(chatId, `发送包含表格的广告截图到群里，我会自动识别并汇总。\n管理界面与帮助：${url}`);
    } else if (text.startsWith('/status')) {
      const port = process.env.WEB_PORT || 8070;
      const host = process.env.HOST || 'http://localhost';
      this.bot.sendMessage(chatId, `状态页：${host}:${port}/admin/status`);
    } else if (text.startsWith('/clear')) {
      const queue = this.getQueue(chatId);
      botStats.queueLength -= queue.getQueue().length;
      queue.clearQueue();
      this.bot.sendMessage(chatId, '已清空等待队列');
    }
  }

  private async processTasks(chatId: number, tasks: ImageTask[]) {
    botStats.isProcessing = true;
    botStats.queueLength -= tasks.length;
    const total = tasks.length;
    const settings = getSettings();
    
    let sentMsg: TelegramBot.Message | null = null;
    try {
      sentMsg = await this.bot.sendMessage(chatId, `连续 ${settings.idle_timeout_seconds} 秒未检测到新截图，共收到 ${total} 张，自动开始识别…`);
    } catch (e) {
      logger.error('Failed to send start processing message', e);
    }

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      task.status = 'processing';
      
      // Update progress message
      if (sentMsg) {
        try {
          await this.bot.editMessageText(`正在识别第 ${i + 1} / ${total} 张...`, {
            chat_id: chatId,
            message_id: sentMsg.message_id
          });
        } catch (e) {
          // ignore edit message error (e.g. same text)
        }
      }

      try {
        // Download file
        const file = await this.bot.getFile(task.file_id);
        const tempDir = path.join(__dirname, '../../temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        
        const localPath = path.join(tempDir, `${task.message_id}_${Date.now()}.jpg`);
        const fileStream = fs.createWriteStream(localPath);
        
        const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
        const response = await fetch(fileUrl);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        fs.writeFileSync(localPath, buffer);
        
        task.localPath = localPath;

        // Process with LLM
        task.result = await this.processor.processImage(task);
        task.status = 'completed';
        successCount++;
        botStats.processedCount++;
      } catch (error) {
        logger.error(`Failed to process task ${task.message_id}`, error);
        task.status = 'failed';
        failCount++;
      }
    }

    if (sentMsg) {
      try {
        await this.bot.editMessageText(`✅ 全部识别完毕！成功 ${successCount} 张 / 失败 ${failCount} 张，正在生成汇总表格…`, {
          chat_id: chatId,
          message_id: sentMsg.message_id
        });
      } catch (e) {}
    }

    try {
      const excelPath = await this.excelGen.generateExcel(tasks);
      await this.bot.sendDocument(chatId, excelPath, {
        caption: '汇总与明细数据'
      });
      
      // Clean up files
      tasks.forEach(t => {
        if (t.localPath && fs.existsSync(t.localPath)) {
          fs.unlinkSync(t.localPath);
        }
      });
      if (fs.existsSync(excelPath)) {
        fs.unlinkSync(excelPath);
      }
    } catch (e) {
      logger.error('Failed to generate or send excel', e);
      this.bot.sendMessage(chatId, '❌ 生成或发送 Excel 文件失败。');
    }

    botStats.isProcessing = false;
  }
}
