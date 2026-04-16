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
import { getSettings, saveSettings } from '../utils/config';
import logger from '../utils/logger';
import { botStats } from './web-admin';

export class BotApp {
  private bot: TelegramBot;
  private queues: Map<number, ImageQueue> = new Map();
  private processor: ImageProcessor;
  private excelGen: ExcelGenerator;
  private allowedChatIds: number[];
  private unauthorizedCache: Map<number, number> = new Map();
  private reportBatches: Map<string, { chatId: number; tasks: ImageTask[]; rowMap: Map<number, { taskIdx: number; itemIdx: number }>; rows: any[]; createdAt: number }> = new Map();
  private aiFixSessions: Map<string, { filename: string; chatId: number; userId: number; promptMessageId: number; createdAt: number }> = new Map();
  private statusMessages: Map<number, number> = new Map();
  private queueStatusTimers: Map<number, NodeJS.Timeout> = new Map();

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
      const userId = msg.from?.id || 0;
      
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

      if (msg.text && msg.reply_to_message && userId) {
        const key = `${chatId}:${userId}`;
        const session = this.aiFixSessions.get(key);
        if (session && session.promptMessageId === msg.reply_to_message.message_id) {
          await this.handleAiFixReply(msg, session);
          return;
        }
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
      const userId = query.from?.id || 0;

      if (query.data?.startsWith('call_report_bot:')) {
        const filename = query.data.split(':')[1];
        const excelPath = path.join(__dirname, '../../temp', filename);

        try {
          await this.bot.answerCallbackQuery(query.id, { text: '⏳ 已开始自动录入，请稍候…' } as any);
        } catch (e) {}

        try {
          await this.bot.editMessageReplyMarkup({
            inline_keyboard: [[{ text: '⏳ 自动录入中…', callback_data: 'noop' }]]
          }, { chat_id: chatId, message_id: messageId });
        } catch (e) {}
        
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
            
            await this.bot.sendMessage(chatId, '✅ 已发起自动录入，请稍候日报机器人处理并在群里回复。', { parse_mode: 'Markdown' });
          } catch (e: any) {
            logger.error(`Failed to call report bot webhook: ${e.message}`);
            const extra =
              String(e?.message || '').includes('HTTP 401')
                ? '\n对方接口需要 BasicAuth：请在截图机器人服务里配置 REPORT_BOT_WEBHOOK_BASIC_AUTH=用户名:密码（或配置 REPORT_BOT_WEBHOOK_USERNAME/REPORT_BOT_WEBHOOK_PASSWORD），然后重启截图机器人。'
                : '';
            await this.bot.sendMessage(chatId, `❌ 自动录入失败：${e.message}\n可能是对方接口未开启、或存在鉴权拦截。${extra}`, { parse_mode: 'Markdown' });
          }
        } else {
          await this.bot.sendMessage(chatId, '⚠️ 日报机器人的互通接口尚未配置，请在后台或环境变量中设置 `REPORT_BOT_WEBHOOK_URL`。', { parse_mode: 'Markdown' });
        }
      } else if (query.data?.startsWith('ai_fix:')) {
        const filename = query.data.split(':')[1];
        await this.startAiFix(chatId, userId, filename, messageId);
        await this.bot.answerCallbackQuery(query.id, { text: '✍️ 请按提示描述需要修改的内容' } as any);
      } else if (query.data === 'do_it_manually') {
        try {
          await this.bot.answerCallbackQuery(query.id, { text: '✅ 已选择人工录入' } as any);
        } catch (e) {}
        try {
          await this.bot.editMessageReplyMarkup({
            inline_keyboard: [[{ text: '✅ 已选择人工录入', callback_data: 'noop' }]]
          }, { chat_id: chatId, message_id: messageId });
        } catch (e) {}
        await this.bot.sendMessage(chatId, '👌 已选择人工录入，本次流程结束。');
      } else if (query.data === 'noop') {
        try {
          await this.bot.answerCallbackQuery(query.id, { text: '处理中…' } as any);
        } catch (e) {}
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

  private scheduleQueueStatusUpdate(chatId: number, count: number) {
    if (this.queueStatusTimers.has(chatId)) {
      clearTimeout(this.queueStatusTimers.get(chatId)!);
    }
    
    this.queueStatusTimers.set(chatId, setTimeout(async () => {
      const text = `⏳ 已收到 ${count} 张截图，等待继续发送...`;
      const lastMsgId = this.statusMessages.get(chatId);
      
      if (lastMsgId) {
        try {
          // Instead of delete and resend which might cause rate limit if the user sends 50 images,
          // let's just delete the old one. We wrap it in a try-catch to ignore errors.
          await this.bot.deleteMessage(chatId, lastMsgId);
        } catch (e) {}
      }
      
      try {
        const msg = await this.bot.sendMessage(chatId, text);
        this.statusMessages.set(chatId, msg.message_id);
      } catch (e) {}
      
      this.queueStatusTimers.delete(chatId);
    }, 500));
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
    this.scheduleQueueStatusUpdate(chatId, queue.getQueue().length);
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
    this.scheduleQueueStatusUpdate(chatId, queue.getQueue().length);
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
      
      const lastMsgId = this.statusMessages.get(chatId);
      if (lastMsgId) {
        try {
          this.bot.deleteMessage(chatId, lastMsgId);
        } catch (e) {}
        this.statusMessages.delete(chatId);
      }
      if (this.queueStatusTimers.has(chatId)) {
        clearTimeout(this.queueStatusTimers.get(chatId)!);
        this.queueStatusTimers.delete(chatId);
      }
      
      this.bot.sendMessage(chatId, '已清空等待队列');
    } else if (text.startsWith('/auth ')) {
      if (chatId !== this.allowedChatIds[0]) return this.bot.sendMessage(chatId, '⛔ 只有超级管理员（配置的第一个ID）可以使用此命令。');
      const newId = parseInt(text.split(' ')[1]);
      if (!newId || isNaN(newId)) return this.bot.sendMessage(chatId, '格式错误，请使用: /auth 123456789');
      
      if (!this.allowedChatIds.includes(newId)) {
        this.allowedChatIds.push(newId);
        const envPath = path.join(process.cwd(), '.env');
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

  private async startAiFix(chatId: number, userId: number, filename: string, sourceMessageId: number) {
    const batch = this.reportBatches.get(filename);
    if (!batch) {
      await this.bot.sendMessage(chatId, '❌ 找不到这份报表对应的数据，可能已过期。请重新发送截图生成一次报表。');
      return;
    }

    const guide = `🤖 *AI 纠错助手已就绪！*\n请直接告诉我你要怎么修改刚出的这份数据。\n\n💡 *描述越具体，我改得越快越准！*\n✅ “把 VIP234-1212-APK102 的点击量改成 4”\n✅ “第2条的消耗改成 1.72，展示改成 670，点击改成 4”\n✅ “删除第3条数据”\n\n👇 请直接回复本消息输入你的修改要求：`;

    const promptMsg = await this.bot.sendMessage(chatId, guide, {
      parse_mode: 'Markdown',
      reply_markup: { force_reply: true, input_field_placeholder: '例如：第1条点击改成4' } as any
    });

    const key = `${chatId}:${userId}`;
    this.aiFixSessions.set(key, { filename, chatId, userId, promptMessageId: promptMsg.message_id, createdAt: Date.now() });

    try {
      await this.bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: sourceMessageId });
    } catch (e) {}
  }

  private async handleAiFixReply(msg: TelegramBot.Message, session: { filename: string; chatId: number; userId: number; promptMessageId: number; createdAt: number }) {
    const chatId = session.chatId;
    const userId = session.userId;
    const key = `${chatId}:${userId}`;
    const instruction = (msg.text || '').trim();
    if (!instruction) return;

    const batch = this.reportBatches.get(session.filename);
    if (!batch) {
      this.aiFixSessions.delete(key);
      await this.bot.sendMessage(chatId, '❌ 找不到这份报表对应的数据，可能已过期。请重新发送截图生成一次报表。');
      return;
    }

    const workingMsg = await this.bot.sendMessage(chatId, '⏳ 正在根据你的描述修正数据并重新生成 Excel，请稍候…');

    try {
      const updatedRows = await this.processor.reviseRows(batch.rows, instruction);
      const updatedRowIds = new Set<number>(updatedRows.map((r: any) => Number(r.rowId)).filter((n: any) => !isNaN(n)));

      updatedRows.forEach((r: any) => {
        const rowId = Number(r.rowId);
        const loc = batch.rowMap.get(rowId);
        if (!loc) return;
        const t = batch.tasks[loc.taskIdx];
        if (!t.result || !t.result[loc.itemIdx]) return;
        const item = t.result[loc.itemIdx] as any;
        item.渠道名 = r.渠道名 ?? item.渠道名;
        item['消耗/U'] = r['消耗/U'] ?? item['消耗/U'];
        item.展示 = r.展示 ?? item.展示;
        item.点击量 = r.点击量 ?? item.点击量;
      });

      const deletionsByTask: Map<number, number[]> = new Map();
      batch.rowMap.forEach((loc, rowId) => {
        if (updatedRowIds.has(rowId)) return;
        if (!deletionsByTask.has(loc.taskIdx)) deletionsByTask.set(loc.taskIdx, []);
        deletionsByTask.get(loc.taskIdx)!.push(loc.itemIdx);
      });
      deletionsByTask.forEach((idxs, taskIdx) => {
        const t = batch.tasks[taskIdx];
        if (!t.result) return;
        idxs.sort((a, b) => b - a).forEach(i => {
          if (t.result && t.result[i]) t.result.splice(i, 1);
        });
      });

      const excelPath = await this.excelGen.generateExcel(batch.tasks);
      const newFilename = path.basename(excelPath);

      const caption =
        `✅ 已根据你的描述修正并生成新的 Excel。\n` +
        `是否呼唤日报机器人自动做日报？\n` +
        `PS:《A45/69T》这张表，可以选择“自动录入”或“人工录入”\n` +
        `如果不属于这张表，只能选择“人工录入”`;

      await this.bot.sendDocument(chatId, excelPath, {
        caption,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '自动录入', callback_data: `call_report_bot:${newFilename}` },
              { text: '人工录入', callback_data: 'do_it_manually' }
            ],
            [
              { text: '🗣 告诉AI哪里错了', callback_data: `ai_fix:${newFilename}` }
            ]
          ]
        }
      });

      const rebuilt = this.buildRows(batch.tasks);
      this.reportBatches.set(newFilename, { chatId, tasks: batch.tasks, rowMap: rebuilt.rowMap, rows: rebuilt.rows, createdAt: Date.now() });
      this.aiFixSessions.delete(key);

      try {
        await this.bot.editMessageText('✅ 修正完成，新的 Excel 已发送。', { chat_id: chatId, message_id: workingMsg.message_id });
      } catch (e) {}
    } catch (e: any) {
      this.aiFixSessions.delete(key);
      try {
        await this.bot.editMessageText(`❌ 修正失败：${e?.message || '未知错误'}`, { chat_id: chatId, message_id: workingMsg.message_id });
      } catch (err) {}
    }
  }

  private buildRows(tasks: ImageTask[]) {
    let rowIdSeq = 1;
    const rows: any[] = [];
    const rowMap: Map<number, { taskIdx: number; itemIdx: number }> = new Map();
    tasks.forEach((t, taskIdx) => {
      if (t.result && t.result.length > 0) {
        t.result.forEach((r, itemIdx) => {
          const rowId = rowIdSeq++;
          rows.push({
            rowId,
            渠道名: (r as any).渠道名 || (r as any).名称 || '',
            '消耗/U': Number((r as any)['消耗/U'] || (r as any).消耗) || 0,
            展示: Number((r as any).展示) || 0,
            点击量: Number((r as any).点击量 || (r as any).点击) || 0
          });
          rowMap.set(rowId, { taskIdx, itemIdx });
        });
      }
    });
    return { rows, rowMap };
  }

  private async processTasks(chatId: number, tasks: ImageTask[]) {
    botStats.isProcessing = true;
    botStats.queueLength -= tasks.length;
    const total = tasks.length;
    
    if (this.queueStatusTimers.has(chatId)) {
      clearTimeout(this.queueStatusTimers.get(chatId)!);
      this.queueStatusTimers.delete(chatId);
    }

    let sentMsgId = this.statusMessages.get(chatId);
    let sentMsg: TelegramBot.Message | null = null;
    
    if (sentMsgId) {
      try {
        await this.bot.deleteMessage(chatId, sentMsgId);
      } catch (e) {}
    }
    
    try {
      sentMsg = await this.bot.sendMessage(chatId, `⏳ 正在提取数据 (0/${total})...`);
      this.statusMessages.set(chatId, sentMsg.message_id);
      sentMsgId = sentMsg.message_id;
    } catch (e) {
      logger.error('Failed to send start processing message', e);
    }

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      task.status = 'processing';
      
      // Update progress message
      if (sentMsgId) {
        try {
          // Use node-fetch to completely bypass undici ETIMEDOUT bugs when editing messages
          const nodeFetch = require('node-fetch');
          await nodeFetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              message_id: sentMsgId,
              text: `⏳ 正在提取数据 (${i + 1}/${total})...`
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

    const built = this.buildRows(tasks);
    const rows = built.rows;
    const rowMap = built.rowMap;

    if (sentMsgId) {
      let summaryText = `📊 *识别完成！(共 ${total} 张图)*\n`;
      if (rows.length === 0) {
        summaryText += `- 未识别到有效数据\n`;
      } else {
        rows.forEach((r: any) => {
          summaryText += `- #${r.rowId} \`${r.渠道名 || '未知'}\` | 消耗: ${r['消耗/U']} | 展示: ${r.展示} | 点击: ${r.点击量}\n`;
        });
      }
      summaryText += `\n👇 *确认无误请点击下方投递按钮；若有误可点击“告诉AI哪里错了”*`;

      try {
        const nodeFetch = require('node-fetch');
        await nodeFetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: sentMsgId,
            text: summaryText,
            parse_mode: 'Markdown'
          }),
          agent: new (require('https').Agent)({ family: 4 })
        });
      } catch (e) {}
      
      this.statusMessages.delete(chatId);
    }

    try {
      const excelPath = await this.excelGen.generateExcel(tasks);
      const filename = path.basename(excelPath);

      const caption =
        `是否呼唤日报机器人自动做日报？\n` +
        `PS:《A45/69T》这张表，可以选择“自动录入”或“人工录入”\n` +
        `如果不属于这张表，只能选择“人工录入”`;
      
      await this.bot.sendDocument(chatId, excelPath, {
        caption,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '自动录入', callback_data: `call_report_bot:${filename}` },
              { text: '人工录入', callback_data: 'do_it_manually' }
            ],
            [
              { text: '🗣 告诉AI哪里错了', callback_data: `ai_fix:${filename}` }
            ]
          ]
        }
      });
      
      this.reportBatches.set(filename, { chatId, tasks, rowMap, rows, createdAt: Date.now() });
      setTimeout(() => {
        tasks.forEach(t => {
          if (t.localPath && fs.existsSync(t.localPath)) {
            try { fs.unlinkSync(t.localPath); } catch (e) {}
          }
        });
        this.reportBatches.delete(filename);
      }, 30 * 60 * 1000);
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
