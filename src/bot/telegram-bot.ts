import TelegramBot from 'node-telegram-bot-api';
import path from 'path';
import fs from 'fs';
import { Agent, setGlobalDispatcher } from 'undici';

// Force global fetch to use IPv4 only, preventing ETIMEDOUT on cloud providers
setGlobalDispatcher(new Agent({ connect: { timeout: 10000 } }));
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
  private unauthorizedCache: Map<number, number> = new Map();
  private queueMessages: Map<number, number> = new Map();

  constructor() {
    const token = process.env.BOT_TOKEN;
    if (!token) {
      throw new Error('BOT_TOKEN is missing in environment variables');
    }
    
    // Disable node-telegram-bot-api's automatic deprecation warnings regarding promises
    process.env.NTBA_FIX_319 = '1';

    this.allowedChatIds = (process.env.MONITOR_CHAT_IDS || '')
      .split(',')
      .map(id => parseInt(id.trim()))
      .filter(id => !isNaN(id));

    this.bot = new TelegramBot(token, {
      polling: {
        interval: 1000, // Increase polling interval to reduce connection drop issues
        autoStart: true,
        params: {
          timeout: 10
        }
      },
      request: {
        agentOptions: {
          keepAlive: true,
          family: 4 
        }
      } as any
    });
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
        } else {
          const now = Date.now();
          const lastTime = this.unauthorizedCache.get(chatId) || 0;
          if (now - lastTime > 10 * 60 * 1000) { // 10 minutes cooldown
            this.bot.sendMessage(chatId, `🔒 抱歉，您暂无处理权限。\n您的 Chat ID 是 \`${chatId}\`，请将此 ID 发送给管理员申请开通。`, { parse_mode: 'Markdown' });
            this.unauthorizedCache.set(chatId, now);
          }
        }
        return;
      }

      if (msg.photo && msg.photo.length > 0) {
        this.handlePhoto(msg);
      } else if (msg.document) {
        const mime = msg.document.mime_type || '';
        if (mime.startsWith('image/')) {
          this.handleDocumentImage(msg);
        }
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

    this.bot.on('callback_query', async (query) => {
      const chatId = query.message?.chat.id;
      const messageId = query.message?.message_id;
      if (!chatId || !messageId) return;

      if (query.data?.startsWith('call_report_bot:')) {
        const filename = query.data.split(':')[1];
        const excelPath = path.join(__dirname, '../../temp', filename);
        
        const settings = getSettings();
        const webhookUrl = process.env.REPORT_BOT_WEBHOOK_URL || settings.integration?.reportBotWebhookUrl;

        if (webhookUrl) {
          try {
            const nodeFetch = require('node-fetch');
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            const basicAuth =
              process.env.REPORT_BOT_WEBHOOK_BASIC_AUTH ||
              (process.env.REPORT_BOT_WEBHOOK_USERNAME && process.env.REPORT_BOT_WEBHOOK_PASSWORD
                ? `${process.env.REPORT_BOT_WEBHOOK_USERNAME}:${process.env.REPORT_BOT_WEBHOOK_PASSWORD}`
                : '');
            if (basicAuth) {
              headers['Authorization'] = `Basic ${Buffer.from(basicAuth).toString('base64')}`;
            }
            const res = await nodeFetch(webhookUrl, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                event: 'new_excel_report',
                chatId: chatId,
                filePath: excelPath,
                filename: filename
              }),
              timeout: 5000
            });
            
            if (!res.ok) {
              throw new Error(`HTTP ${res.status} ${res.statusText}`);
            }
            
            await this.bot.sendMessage(chatId, '✅ 已经成功通过内网将 Excel 数据投递给日报机器人！请稍候它会在群里给您回复。', { parse_mode: 'Markdown' });
          } catch (e: any) {
            logger.error(`Failed to call report bot webhook: ${e.message}`);
            const extra =
              String(e?.message || '').includes('HTTP 401')
                ? '\n对方接口需要 BasicAuth：请在截图机器人服务里配置 REPORT_BOT_WEBHOOK_BASIC_AUTH=用户名:密码（或配置 REPORT_BOT_WEBHOOK_USERNAME/REPORT_BOT_WEBHOOK_PASSWORD），然后重启截图机器人。'
                : '';
            await this.bot.sendMessage(chatId, `❌ 投递给日报机器人失败：${e.message}\n可能是对方接口未开启、或存在鉴权拦截。${extra}`, { parse_mode: 'Markdown' });
          }
        } else {
          await this.bot.sendMessage(chatId, '⚠️ 日报机器人的互通接口尚未配置，请在后台或环境变量中设置 `REPORT_BOT_WEBHOOK_URL`。', { parse_mode: 'Markdown' });
        }

        // Remove the inline keyboard after selection
        await this.bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
        await this.bot.answerCallbackQuery(query.id);
      } else if (query.data === 'do_it_manually') {
        await this.bot.sendMessage(chatId, '👌 好的，流程结束，辛苦啦！');
        // Remove the inline keyboard after selection
        await this.bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
        await this.bot.answerCallbackQuery(query.id);
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

  private async handleDocumentImage(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const document = msg.document!;
    
    const task: ImageTask = {
      message_id: msg.message_id,
      file_id: document.file_id,
      chat_id: chatId,
      timestamp: msg.date,
      caption: msg.caption || '',
      status: 'pending'
    };

    const queue = this.getQueue(chatId);
    queue.addTask(task);
    
    botStats.queueLength++;
    await this.updateQueueMessage(chatId, queue);
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
      caption: msg.caption || '', // Capture the caption if it exists
      status: 'pending'
    };

    const queue = this.getQueue(chatId);
    queue.addTask(task);
    
    botStats.queueLength++;
    await this.updateQueueMessage(chatId, queue);
  }

  private async updateQueueMessage(chatId: number, queue: ImageQueue) {
    const settings = getSettings();
    const len = queue.getQueue().length;
    if (len === 0) return;
    
    const text = `📥 已暂存 ${len} 张截图，${settings.idle_timeout_seconds}秒后开始合并识别... (发送更多截图可刷新倒计时)`;
    
    try {
      if (len === 1) {
        const msg = await this.bot.sendMessage(chatId, text);
        this.queueMessages.set(chatId, msg.message_id);
      } else {
        const msgId = this.queueMessages.get(chatId);
        if (msgId) {
          // Use node-fetch to bypass edit timeouts
          const nodeFetch = require('node-fetch');
          await nodeFetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              message_id: msgId,
              text: text
            }),
            agent: new (require('https').Agent)({ family: 4 })
          });
        }
      }
    } catch (e) {
      logger.error('Failed to update queue message:', e);
    }
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
      const host = process.env.HOST || 'http://www.runtoads.top';
      const adminUrl = `${host}:${port}/admin/`;
      const helpText = `*机器人帮助文档*
- 功能简介：自动解析广告数据截图并生成Excel汇总，支持一键投递给日报机器人。
- 指令列表：
  /id - 获取当前群Chat ID
  /test - 测试内部群连通性
  /help - 查看帮助和FAQ
  /status - 获取状态页URL
  /clear - 清空等待处理的图片队列
- 常见问题：
  1. 若数字识别不准，请尽量在发送图片时选择“作为文件发送(File)”以保持原图清晰度。
  2. 若机器人未回复，请检查管理后台的API Key是否配置正确或欠费。
- 综合管理后台：\`${adminUrl}\``;
      this.bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
    } else if (text.startsWith('/status')) {
      const port = process.env.WEB_PORT || 8070;
      const host = process.env.HOST || 'http://www.runtoads.top';
      this.bot.sendMessage(chatId, `状态页：${host}:${port}/admin/status`);
    } else if (text.startsWith('/clear')) {
      const queue = this.getQueue(chatId);
      botStats.queueLength -= queue.getQueue().length;
      queue.clearQueue();
      this.bot.sendMessage(chatId, '已清空等待队列');
    } else if (text.startsWith('/auth ')) {
      if (chatId !== this.allowedChatIds[0]) return this.bot.sendMessage(chatId, '⛔ 只有超级管理员（配置的第一个ID）可以使用此命令。');
      const newId = parseInt(text.split(' ')[1]);
      if (!newId || isNaN(newId)) return this.bot.sendMessage(chatId, '格式错误，请使用: /auth 123456789');
      
      if (!this.allowedChatIds.includes(newId)) {
        this.allowedChatIds.push(newId);
        // Append to .env file
        const envPath = path.join(__dirname, '../../.env');
        if (fs.existsSync(envPath)) {
          let envContent = fs.readFileSync(envPath, 'utf8');
          if (envContent.includes('MONITOR_CHAT_IDS=')) {
            envContent = envContent.replace(/(MONITOR_CHAT_IDS=.*)/, `$1,${newId}`);
          } else {
            envContent += `\nMONITOR_CHAT_IDS=${this.allowedChatIds.join(',')}`;
          }
          fs.writeFileSync(envPath, envContent);
        }
        this.bot.sendMessage(chatId, `✅ 成功授权 ID: ${newId}，已写入配置。`);
      } else {
        this.bot.sendMessage(chatId, `⚠️ ID: ${newId} 已经在白名单中`);
      }
    } else if (text.startsWith('/model ')) {
      if (chatId !== this.allowedChatIds[0]) return this.bot.sendMessage(chatId, '⛔ 只有超级管理员可以使用此命令。');
      const newModel = text.split(' ')[1];
      if (!newModel) return this.bot.sendMessage(chatId, '格式错误，请使用: /model gpt-4o');
      const settings = getSettings();
      settings.llm.model = newModel;
      saveSettings(settings);
      this.bot.sendMessage(chatId, `✅ 主力模型已一键切换为: ${newModel}`);
    }
  }

  private async processTasks(chatId: number, tasks: ImageTask[]) {
    botStats.isProcessing = true;
    botStats.queueLength -= tasks.length;
    const total = tasks.length;
    const settings = getSettings();
    
    let sentMsg: TelegramBot.Message | null = null;
    try {
      await this.bot.sendMessage(chatId, `连续 ${settings.idle_timeout_seconds} 秒未检测到新截图，共收到 ${total} 张，自动开始识别…`);
      sentMsg = await this.bot.sendMessage(chatId, `正在准备处理...`);
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
          // Use node-fetch to completely bypass undici ETIMEDOUT bugs when editing messages
          const nodeFetch = require('node-fetch');
          await nodeFetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              message_id: sentMsg.message_id,
              text: `正在识别第 ${i + 1} / ${total} 张...`
            }),
            agent: new (require('https').Agent)({ family: 4 })
          });
        } catch (e) {
          // ignore edit message error (e.g. same text)
        }
      }

      try {
        logger.info(`[Step 1] Getting file path from Telegram for file_id: ${task.file_id}`);
        // Instead of this.bot.getFile, manually fetch to control the agent and bypass undici/request errors
        const nodeFetch = require('node-fetch');
        
        // Add timeout to node-fetch request
        const AbortController = require('abort-controller');
        const controller1 = new AbortController();
        const timeout1 = setTimeout(() => { controller1.abort(); }, 15000);
        
        let getFileRes;
        try {
          getFileRes = await nodeFetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getFile?file_id=${task.file_id}`, {
            signal: controller1.signal,
            agent: new (require('https').Agent)({ family: 4 }) // Force IPv4, often the root cause of ETIMEDOUT on cloud providers
          });
        } finally {
          clearTimeout(timeout1);
        }
        
        const fileData = await getFileRes.json();
        
        if (!fileData.ok) {
           throw new Error("Failed to get file info from Telegram: " + JSON.stringify(fileData));
        }
        const file = fileData.result;
        
        const tempDir = path.join(__dirname, '../../temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        
        const localPath = path.join(tempDir, `${task.message_id}_${Date.now()}.jpg`);
        
        logger.info(`[Step 2] Downloading image from Telegram: ${file.file_path}`);
        const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
        
        // We use node-fetch to completely bypass undici ETIMEDOUT bugs on cloud instances
        const controller2 = new AbortController();
        const timeout2 = setTimeout(() => { controller2.abort(); }, 15000);
        
        let response;
        try {
          response = await nodeFetch(fileUrl, { 
            signal: controller2.signal,
            agent: new (require('https').Agent)({ family: 4 })
          });
        } finally {
          clearTimeout(timeout2);
        }
        
        if (!response.ok) {
           throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        fs.writeFileSync(localPath, buffer);
        
        task.localPath = localPath;
        logger.info(`[Step 3] Image downloaded successfully: ${localPath} (Size: ${buffer.length} bytes)`);

        // Process with LLM
        logger.info(`[Step 4] Sending image to LLM processor...`);
        task.result = await this.processor.processImage(task);
        logger.info(`[Step 5] LLM processing completed successfully.`);
        
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
      // Build summary text
      let summaryText = `📊 **识别完成！(共 ${total} 张图)**\n`;
      tasks.forEach((t, idx) => {
        if (t.result && t.result.length > 0) {
          t.result.forEach(r => {
            summaryText += `- \`${r['渠道名'] || '未知'}\` | 消耗: ${r['消耗/U'] || 0} | 展示: ${r['展示'] || 0} | 点击: ${r['点击量'] || 0}\n`;
          });
        } else {
          summaryText += `- 第 ${idx + 1} 张图未识别到有效数据\n`;
        }
      });
      summaryText += `\n👇 *确认无误请点击下方投递按钮，若有误可重新发送*`;

      try {
        const nodeFetch = require('node-fetch');
        await nodeFetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: sentMsg.message_id,
            text: summaryText,
            parse_mode: 'Markdown'
          }),
          agent: new (require('https').Agent)({ family: 4 })
        });
      } catch (e) {}
      
      // Clear queue message tracking for this chat
      this.queueMessages.delete(chatId);
    }

    try {
      const excelPath = await this.excelGen.generateExcel(tasks);
      const filename = path.basename(excelPath);

      const caption =
        `是否呼唤日报机器人自动做日报？\n` +
        `PS:《A45/69T》这张表，可以选择“机器做”或“自己做”\n` +
        `如果不属于这张表，只能选择“自己做”`;
      
      await this.bot.sendDocument(chatId, excelPath, {
        caption,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '机器做', callback_data: `call_report_bot:${filename}` },
              { text: '自己做', callback_data: 'do_it_manually' }
            ]
          ]
        }
      });
      
      // Clean up image files
      tasks.forEach(t => {
        if (t.localPath && fs.existsSync(t.localPath)) {
          fs.unlinkSync(t.localPath);
        }
      });
      // IMPORTANT: Do NOT delete the excelPath here. 
      // It must persist on disk so the Report Bot can read it via webhook later.
      // A cron job or the Report Bot should be responsible for cleaning up old excel files.
    } catch (e) {
      logger.error('Failed to generate or send excel', e);
      this.bot.sendMessage(chatId, '❌ 生成或发送 Excel 文件失败。');
    }

    botStats.isProcessing = false;
  }
}
