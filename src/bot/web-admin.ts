import express from 'express';
import basicAuth from 'express-basic-auth';
import { getSettings, saveSettings, backupSettings } from '../utils/config';
import { Settings } from '../types';
import logger from '../utils/logger';

export const adminRouter = express.Router();

adminRouter.get('/', (req, res) => {
  res.redirect('/admin/status');
});

const username = process.env.ADMIN_USERNAME;
const password = process.env.ADMIN_PASSWORD;

if (username && password) {
  adminRouter.use(basicAuth({
    users: { [username]: password },
    challenge: true
  }));
}

// Global stats (could be injected from main logic)
export const botStats = {
  status: 'online',
  startTime: Date.now(),
  queueLength: 0,
  isProcessing: false,
  processedCount: 0,
  llmStatus: 'unknown',
  lastConfigUpdate: Date.now()
};

adminRouter.get('/config', (req, res) => {
  const settings = getSettings();
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <title>${settings.ui.pageTitle} - 配置</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f4f4f4; }
        .container { max-width: 800px; margin: auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
        label { display: block; margin-top: 10px; font-weight: bold; }
        input, select, textarea { width: 100%; padding: 8px; margin-top: 5px; box-sizing: border-box; }
        button { margin-top: 20px; padding: 10px 15px; background: #007bff; color: white; border: none; cursor: pointer; border-radius: 4px; }
        button:hover { background: #0056b3; }
        .footer { margin-top: 20px; text-align: center; color: #888; font-size: 12px; }
        nav a { margin-right: 15px; color: #007bff; text-decoration: none; }
        nav a:hover { text-decoration: underline; }
      </style>
    </head>
    <body>
      <div class="container">
        <nav>
          <a href="/admin/status">状态</a>
          <a href="/admin/config">配置</a>
          <a href="/admin/guide">帮助</a>
          <a href="/admin/customize">定制服务</a>
        </nav>
        <h2>配置参数</h2>
        <form id="configForm">
          <label>空闲超时时长（秒）:</label>
          <input type="number" id="idle_timeout_seconds" value="${settings.idle_timeout_seconds}" min="1" required>
          
          <label>大模型 Provider:</label>
          <input type="text" id="llm_provider" value="${settings.llm.provider}" required>
          
          <label>API Key:</label>
          <input type="password" id="llm_apiKey" value="${settings.llm.apiKey}">
          
          <label>Base URL:</label>
          <input type="text" id="llm_baseUrl" value="${settings.llm.baseUrl}" required>
          
          <label>Model:</label>
          <input type="text" id="llm_model" value="${settings.llm.model}" required>
          
          <label>System Prompt: <button type="button" onclick="resetPrompt()" style="font-size: 12px; padding: 2px 8px; margin-left: 10px; background: #dc3545;">获取系统最新默认提示词</button></label>
          <textarea id="llm_systemPrompt" rows="8" required>${settings.llm.systemPrompt}</textarea>
          
          <label>互通接口地址 (Webhook) - 留空表示不开启投递:</label>
          <input type="text" id="reportBotWebhookUrl" value="${settings.integration?.reportBotWebhookUrl || ''}" placeholder="例如: http://127.0.0.1:8080/api/receive-excel">
          
          <button type="button" onclick="saveConfig()">保存并生效</button>
          <button type="button" onclick="backupConfig()" style="background: #28a745;">备份当前配置</button>
        </form>
        <div class="footer">${settings.ui.companyFooter}</div>
      </div>
      <script>
        async function saveConfig() {
          const config = {
            idle_timeout_seconds: parseInt(document.getElementById('idle_timeout_seconds').value),
            llm: {
              provider: document.getElementById('llm_provider').value,
              apiKey: document.getElementById('llm_apiKey').value,
              baseUrl: document.getElementById('llm_baseUrl').value,
              model: document.getElementById('llm_model').value,
              maxTokens: ${settings.llm.maxTokens},
              temperature: ${settings.llm.temperature},
              systemPrompt: document.getElementById('llm_systemPrompt').value
            },
            excel: {
              mergeDuplicateNames: ${settings.excel.mergeDuplicateNames},
              sortByName: ${settings.excel.sortByName}
            },
            ui: {
              pageTitle: "${settings.ui.pageTitle}",
              companyFooter: "${settings.ui.companyFooter}"
            },
            integration: {
              reportBotWebhookUrl: document.getElementById('reportBotWebhookUrl').value
            }
          };
          
          const res = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
          });
          if(res.ok) alert('保存成功，已热重载！');
          else alert('保存失败！');
        }
        
        async function backupConfig() {
          const res = await fetch('/api/config/backup', { method: 'POST' });
          if(res.ok) alert('备份成功！');
          else alert('备份失败！');
        }

        async function resetPrompt() {
          if (confirm('确定要获取系统内置的最新的、经过防错优化的 System Prompt 吗？\\n这将会覆盖输入框里的内容（但你需要点击“保存并生效”才会真正保存）。')) {
            const res = await fetch('/admin/api/default-prompt');
            const data = await res.json();
            document.getElementById('llm_systemPrompt').value = data.prompt;
          }
        }
      </script>
    </body>
    </html>
  `);
});

adminRouter.get('/api/default-prompt', (req, res) => {
  const { DEFAULT_SETTINGS } = require('../utils/config');
  res.json({ prompt: DEFAULT_SETTINGS.llm.systemPrompt });
});

adminRouter.get('/status', (req, res) => {
  const settings = getSettings();
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <title>${settings.ui.pageTitle} - 状态</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f4f4f4; }
        .container { max-width: 800px; margin: auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
        .stat-item { margin-bottom: 10px; font-size: 16px; }
        nav a { margin-right: 15px; color: #007bff; text-decoration: none; }
        .footer { margin-top: 20px; text-align: center; color: #888; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <nav>
          <a href="/admin/status">状态</a>
          <a href="/admin/config">配置</a>
          <a href="/admin/guide">帮助</a>
          <a href="/admin/customize">定制服务</a>
        </nav>
        <h2>运行状态</h2>
        <div id="stats">加载中...</div>
        <div class="footer">${settings.ui.companyFooter}</div>
      </div>
      <script>
        async function loadStatus() {
          const res = await fetch('/api/status');
          if(res.ok) {
            const data = await res.json();
            const uptime = Math.floor((Date.now() - data.startTime) / 1000);
            const statusColor = data.status === 'online' ? '🟢' : '🔴';
            document.getElementById('stats').innerHTML = \`
              <div class="stat-item">状态: \${statusColor} \${data.status}</div>
              <div class="stat-item">启动时长: \${uptime} 秒</div>
              <div class="stat-item">当前队列图片数: \${data.queueLength}</div>
              <div class="stat-item">是否正在识别: \${data.isProcessing ? '是' : '否'}</div>
              <div class="stat-item">累计处理图片数: \${data.processedCount}</div>
            \`;
          }
        }
        loadStatus();
        setInterval(loadStatus, 30000);
      </script>
    </body>
    </html>
  `);
});

adminRouter.get('/guide', (req, res) => {
  const settings = getSettings();
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <title>${settings.ui.pageTitle} - 帮助</title>
      <style>
        body { font-family: 'Comic Sans MS', cursive, sans-serif; margin: 20px; background: #fffaf0; color: #555; }
        .container { max-width: 800px; margin: auto; background: white; padding: 20px; border-radius: 12px; border: 2px solid #ffe4b5; }
        h2 { color: #ff8c00; }
        p { line-height: 1.6; }
        nav a { margin-right: 15px; color: #ff8c00; text-decoration: none; font-weight: bold; }
        .footer { margin-top: 20px; text-align: center; color: #aaa; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <nav>
          <a href="/admin/status">状态</a>
          <a href="/admin/config">配置</a>
          <a href="/admin/guide">帮助</a>
          <a href="/admin/customize">定制服务</a>
        </nav>
        <h2>🤖 截图机器人使用指南</h2>
        <p><strong>我能做什么？</strong><br>发送包含表格的广告截图到群里，我会自动读取图片上的数据，并在等待 ${settings.idle_timeout_seconds} 秒后将所有截图汇总成一份 Excel 表格发给你哦！</p>
        <p><strong>如何使用？</strong><br>只要把图片直接发到群里就可以啦！如果是连续发送多张，我会等你不发了之后一起处理。</p>
        <p><strong>指令列表：</strong><br>
        <code>/id</code> - 获取当前群的 Chat ID<br>
        <code>/test</code> - 测试我是否在线<br>
        <code>/help</code> - 获取帮助信息<br>
        <code>/status</code> - 获取状态页地址<br>
        <code>/clear</code> - 紧急清空当前的等待队列
        </p>
        <div class="footer">${settings.ui.companyFooter}</div>
      </div>
    </body>
    </html>
  `);
});

adminRouter.get('/customize', (req, res) => {
  const settings = getSettings();
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <title>${settings.ui.pageTitle} - 定制服务</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f4f4f4; }
        .container { max-width: 800px; margin: auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
        nav a { margin-right: 15px; color: #007bff; text-decoration: none; }
        .footer { margin-top: 20px; text-align: center; color: #888; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <nav>
          <a href="/admin/status">状态</a>
          <a href="/admin/config">配置</a>
          <a href="/admin/guide">帮助</a>
          <a href="/admin/customize">定制服务</a>
        </nav>
        <h2>定制您的专属机器人</h2>
        <p>欢迎联系 <strong>RuntoAds.Top</strong> 技术团队定制各种专属 Telegram 机器人服务！</p>
        <ul>
          <li>数据统计机器人</li>
          <li>群管机器人</li>
          <li>自动化工作流集成</li>
        </ul>
        <p>联系方式：<a href="#">support@runtoads.top</a></p>
        <div class="footer">${settings.ui.companyFooter}</div>
      </div>
    </body>
    </html>
  `);
});

// API Routes
export const apiRouter = express.Router();

apiRouter.get('/config', (req, res) => {
  res.json(getSettings());
});

apiRouter.post('/config', express.json(), (req, res) => {
  try {
    const newSettings = req.body as Settings;
    saveSettings(newSettings);
    botStats.lastConfigUpdate = Date.now();
    res.json({ status: 'success' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/config/backup', (req, res) => {
  try {
    const backupPath = backupSettings();
    res.json({ status: 'success', path: backupPath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/status', (req, res) => {
  res.json(botStats);
});
