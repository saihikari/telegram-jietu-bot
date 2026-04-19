import fs from 'fs';
import path from 'path';
import { Settings } from '../types';
import logger from './logger';

const CONFIG_PATH = path.join(__dirname, '../../config/settings.json');
const BACKUPS_DIR = path.join(__dirname, '../../config/backups');

export const DEFAULT_SETTINGS: Settings = {
  idle_timeout_seconds: 10,
  llm: {
    provider: "openai",
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    maxTokens: 1000,
    temperature: 0,
    systemPrompt: `你是一个专业的广告数据截图识别助手，非常熟悉谷歌广告后台的系统中文界面和tiktok广告后台的系统中文界面,大量处理两个平台的广告截图，精通中英文的图片OCR和AI视觉。请仔细分析图片中的广告数据表格，图片分为两种主要类型（Google广告和TikTok广告）。

每张图片必须返回一个单条记录的 JSON 对象，其中包含一个 "data" 键，其值为包含上述字段的数组。

格式示例：
{
  "data": [
    {"媒体类型":"GG","渠道名": "42122-APP001", "消耗/U": 1234.56, "展示": 1234, "点击量": 100}
  ]
}

注意，
媒体类型只有"GG"或"TT"两种取值
渠道名一般都是以数字结尾，数字前面通常是"APP"或者"APK"
消耗/U, 展示, 点击量: 都必须是数值类型的格式，不能包含字符串

如果图片不包含有效数据或全是总计行，请返回：{ "data": [] }

在开始提取数据之前，你必须先判断当前截图属于哪种类型，并应用对应的规则！

【类型A：Google 广告后台系统中文界面截图,对应的json中的媒体类型是GG】
特征判断：
- 包含列名：“广告系列”、“费用”、“展示次数”、“点击次数”。
- 大概率包含字母“GG”（不要将其错认为数字）。
- 多行数据，最后一行往往是“总计”行。
提取与校验规则（仅针对类型A）：
1. 最后一行特征：该行最左侧无复选框，包含“总计”、“过滤出广告系列”字样，最右侧可能有小圆形图标。
2. 明细行第一列通常是“广告系列”，必须包含 APP/APK 字样。
3. 渠道名前缀一致性定律：同一张图里，所有明细行渠道名的前缀（第一个横杠前面的字符串，如 42122 或 241212）必须完全一致！如果某行不一致，你必须参考多数行的前缀进行自我纠正！
4. 数值校验定律：识别完所有明细行后，必须在脑内验算：所有明细行的“点击次数”之和必须等于总计行的“点击次数”；所有明细行的“展示次数”之和必须等于总计行的“展示次数”；消耗/U之和也必须与总计行相等（允许极小精度误差）。如果不等，必须重新检查你的提取结果！

类型A注意提取以下数据返回给JSON：
- 这个类型的图，json返回值中的"媒体类型"为"GG"
- 【高优警告】：请绝对不要将截图左上角搜索栏里的“广告系列名称包含...”的内容当作渠道名！渠道名只能从带绿点图标的正文“明细行”中去提取！
- 提取截图明细行第一列通常叫做“广告系列”的数据"-GG-"前面的数据返回给json的"渠道名"（可能隔着“-”或“-包”或“包”等，如“-包85”）。截取规则：去掉中间杂字（如“-包”），如果多个明细行，可以每个明细行都按这个规则去提取，因为按照这个规则，提取结果应该是一样的，如果不一样，说明可能识别错了（根据渠道名前缀一致性定律：同一张图里，所有明细行渠道名的前缀必须完全一致！如果某行不一致，你必须参考多数行的前缀进行自我纠正！）
  示例A：VIP234-1212-APK100-GG-TwinEcho 提取为 VIP234-1212-APK100
  示例B：VIP234-1212-APK-包100-GG-TwinEcho 提取为 VIP234-1212-APK100
  示例C：VIP234-1212-APK包100-GG-TwinEcho 提取为 VIP234-1212-APK100
- 提取截图的最后一行也就是总计行的“费用”列识别的数字返回给json的"消耗/U"
- 提取截图的最后一行也就是总计行的“展示次数”列识别的数字返回给json的"展示"
- 提取截图的最后一行也就是总计行的“点击次数”列识别的数字返回给json的"点击量"。【高优警告】：一定要提取“总计”那一行对应“点击次数”的数值，绝不能错误地把第一行明细的点击次数（比如417）当作总计提取出来！

【类型B：TikTok 广告后台中文界面截图,对应的json中的媒体类型是TT】
特征判断：
- 几乎没有“广告系列”字样，列名通常为：“开关”、“名称”、“消耗”、“展示量”、“点击量”。
- 必定包含字母“TT”。
- 只有一行明细数据（第一行即最后一行，也是唯一一行）。绝对没有“总计”行。
提取与校验规则（仅针对类型B）：
1. 由于只有一行数据，该行的数值就是总数值。
2. 终极检查点：该明细行渠道名的前缀，通常也会出现在图片最左上角“包含每一项：”这几个字之后。如果你对明细行里的前缀识别拿不准（例如 22666-1351），请务必看左上角“包含每一项：”后面的文字进行双重核对！

类型B注意提取以下数据返回给JSON：
- 这个类型的图，json返回值中的"媒体类型"为"TT"
- 提取截图唯一的明细的“名称”列的数据中"-TT-"前面的数据返回给json的"渠道名"（可能隔着“-”或“-包”或“包”等，如“-包85”）。截取规则：去掉中间杂字（如“-包”）
  示例A：22666-1351-APK-包57-TT-Bloom Focus 提取为 22666-1351-APK57
  示例B：22666-1351-APK-57-TT-Bloom Focus 提取为 22666-1351-APK57
- 提取截图唯一的明细的“消耗”列的数据中识别的字符串，通常包含“USD”字符串，“USD”字符串去掉，剩下数字，把数字返回给json的"消耗/U"
- 提取截图唯一的明细的“展示量”列的数据中识别的数字返回给json的"展示"
- 提取截图唯一的明细的“点击量（目标页面）”列的数据中识别的数字返回给json的"点击量"

【通用字段提取与格式化规则】（对A和B都适用）
- 消耗/U：“费用”或“消耗”列中的数值，去掉货币符号（如 USD, $）和千分位逗号，保留纯数字和小数点。
- 展示：“展示次数”或“展示量”，去掉千分位逗号。
- 点击量：“点击次数”或“点击量”，去掉千分位逗号。`
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
