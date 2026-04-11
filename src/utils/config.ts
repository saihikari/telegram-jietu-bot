import fs from 'fs';
import path from 'path';
import { Settings } from '../types';
import logger from './logger';

const CONFIG_PATH = path.join(__dirname, '../../config/settings.json');
const BACKUPS_DIR = path.join(__dirname, '../../config/backups');

const DEFAULT_SETTINGS: Settings = {
  idle_timeout_seconds: 10,
  llm: {
    provider: "openai",
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    maxTokens: 1000,
    temperature: 0,
    systemPrompt: "你是一个专业的广告数据截图识别助手。请仔细分析图片中的广告数据表格，忽略“总计”、“合计”或无关行。\n对于每一行有效数据，提取以下字段：\n- 渠道名：在“广告系列名称”列中找出“APK”或“APP”（不区分大小写），找到它后面的数字字符串（不论中间是否有“-”）。截取从开头一直到这个数字字符串结束的所有内容作为“渠道名”。（例如：42122-APP001-GG-Jigsaw 提取为 42122-APP001）。\n- 消耗/U：“费用”列中找到费用数值，去掉货币符号和千分位逗号，保留纯数字和小数点（如 $1,234.56 提取为 1234.56）。\n- 展示：“展示次数”，去掉千分位逗号（如 1,234 提取为 1234）。\n- 点击量：“点击次数”，去掉千分位逗号，结果放在“点击量”。\n\n请必须返回一个 JSON 对象，其中包含一个 \"data\" 键，其值为包含上述字段的数组。\n格式示例：\n{\n  \"data\": [\n    {\"渠道名\": \"42122-APP001\", \"消耗/U\": 1234.56, \"展示\": 1234, \"点击量\": 100}\n  ]\n}\n如果图片不包含有效数据或全是总计行，请返回：{ \"data\": [] }"
  },
  excel: {
    mergeDuplicateNames: true,
    sortByName: true
  },
  ui: {
    pageTitle: "截图机器人管理后台",
    companyFooter: "机器人系统由RuntoAds技术团队提供支持"
  },
  integration: {
    reportBotWebhookUrl: ""
  }
};

let currentSettings: Settings;

export function loadSettings(): Settings {
  if (!fs.existsSync(CONFIG_PATH)) {
    logger.info('settings.json not found, creating default settings.');
    saveSettings(DEFAULT_SETTINGS);
    currentSettings = DEFAULT_SETTINGS;
  } else {
    try {
      const data = fs.readFileSync(CONFIG_PATH, 'utf-8');
      currentSettings = JSON.parse(data);
    } catch (error) {
      logger.error('Failed to parse settings.json, using default settings.', error);
      currentSettings = DEFAULT_SETTINGS;
    }
  }
  return currentSettings;
}

export function getSettings(): Settings {
  if (!currentSettings) {
    return loadSettings();
  }
  return currentSettings;
}

export function saveSettings(settings: Settings): void {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(settings, null, 2), 'utf-8');
    currentSettings = settings;
    logger.info('Settings saved and reloaded.');
  } catch (error) {
    logger.error('Failed to save settings.', error);
    throw error;
  }
}

export function backupSettings(): string {
  try {
    if (!fs.existsSync(BACKUPS_DIR)) {
      fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').slice(0, 15);
    const backupPath = path.join(BACKUPS_DIR, `settings_${timestamp}.json`);
    fs.copyFileSync(CONFIG_PATH, backupPath);
    logger.info(`Settings backed up to ${backupPath}`);
    return backupPath;
  } catch (error) {
    logger.error('Failed to backup settings.', error);
    throw error;
  }
}
