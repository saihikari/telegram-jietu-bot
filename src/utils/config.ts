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
    systemPrompt: "你是一个广告截图识别助手。请分析图片中的广告数据表格，忽略“总计”或“合计”行。对于每一行非总计数据，提取以下字段：\n- 名称：从广告系列列中提取“APK”或“APP”后面的数字/字母组合，通常位于两个“-”之间（如 xxx-APK123-yyy → APK123）。\n- 消耗：费用数值，去掉货币符号和千分位逗号，保留数字和小数点（如 ¥1,234.56 → 1234.56）。\n- 展示：展示次数，去掉逗号（如 1,234 → 1234）。\n- 点击：点击次数，去掉逗号。\n\n返回 JSON 数组，每个元素格式：{\"名称\": \"...\", \"消耗\": 数字, \"展示\": 数字, \"点击\": 数字}\n如果图片不包含有效数据或为总计行，返回空数组。"
  },
  excel: {
    mergeDuplicateNames: true,
    sortByName: true
  },
  ui: {
    pageTitle: "截图机器人管理后台",
    companyFooter: "机器人系统由RuntoAds技术团队提供支持"
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
