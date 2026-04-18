import fs from 'fs';
import path from 'path';
import { OpenAI } from 'openai';
import { getSettings } from '../utils/config';
import { AdData, ImageTask } from '../types';
import logger from '../utils/logger';
import https from 'https';

// Create a custom HTTPS agent to bypass strict HTTP/2 handling issues in some Node.js versions
const httpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false, // Sometimes proxy certs cause issues
  family: 4 // Force IPv4
});

// Use native node-fetch like behavior but via a wrapper that enforces the custom agent
const customFetch = async (url: any, init: any): Promise<any> => {
  const options = {
    ...init,
    agent: httpsAgent,
    // Add extra headers to avoid ChatAnywhere 405 or interception
    headers: {
      ...init?.headers,
      'Accept': 'application/json',
      'User-Agent': 'OpenAI/NodeJS/4.104.0'
    }
  };
  // We use node-fetch under the hood which is what OpenAI SDK expects
  const nodeFetch = require('node-fetch');
  
  // Force IPv4 in node-fetch options by modifying the underlying http.request options
  options.family = 4;
  try {
    logger.info(`[customFetch] Executing fetch to ${url} with method ${init?.method || 'GET'}`);
    const res = await nodeFetch(url, options);
    return res;
  } catch (err: any) {
    logger.error(`[customFetch] Error: ${err.message}`, err);
    throw err;
  }
};

// remove getClient as it's no longer used
export class ImageProcessor {
  public async processImage(task: ImageTask): Promise<AdData[]> {
    if (!task.localPath || !fs.existsSync(task.localPath)) {
      throw new Error(`Image not found: ${task.localPath}`);
    }

    const settings = getSettings();
    
    try {
      const base64Image = fs.readFileSync(task.localPath, 'base64');
      const dataUrl = `data:image/jpeg;base64,${base64Image}`;

      const rawBaseUrl = (process.env.LLM_BASE_URL || settings.llm.baseUrl || '').trim();
      const safeBaseUrl = rawBaseUrl
        .replace(/^`|`$/g, '')
        .replace(/^"|"$/g, '')
        .replace(/^'|'$/g, '')
        .replace(/\/$/, '');
      const apiKey = (process.env.LLM_API_KEY || settings.llm.apiKey || '').trim().replace(/^`|`$/g, '').replace(/^"|"$/g, '').replace(/^'|'$/g, '');
      const model = (process.env.LLM_MODEL || settings.llm.model || '').trim().replace(/^`|`$/g, '').replace(/^"|"$/g, '').replace(/^'|'$/g, '');
      logger.info(`[LLM Config] Calling LLM API via ${safeBaseUrl} with model ${model || settings.llm.model}`);

      // We pass an abort signal to the fetch call inside openai to prevent hanging
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout for LLM

      let response: any = null;
      try {
        logger.info(`[LLM Request] Starting request to OpenAI API...`);
        
        const client = new OpenAI({
          apiKey,
          baseURL: safeBaseUrl,
          fetch: customFetch as any
        });
        
        const messages: any[] = [
          { role: "system", content: settings.llm.systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: "请识别这张截图中的广告数据：" },
              { type: "image_url", image_url: { url: dataUrl } }
            ]
          }
        ];

        let lastErr: any = null;
        for (const withResponseFormat of [true, false]) {
          try {
            const req: any = {
              model,
              messages,
              max_tokens: settings.llm.maxTokens,
              temperature: settings.llm.temperature
            };
            if (withResponseFormat) req.response_format = { type: "json_object" };
            response = await client.chat.completions.create(req, { signal: controller.signal as any });
            break;
          } catch (e: any) {
            lastErr = e;
            const status = e?.status || e?.response?.status || e?.response?.statusCode;
            const data = e?.response?.data || e?.response || {};
            const combined = `${e?.message || ''} ${JSON.stringify(data)}`;
            if (withResponseFormat && status === 400 && /response_format|json_object|json schema|invalid_request/i.test(combined)) {
              logger.warn('[LLM] response_format not supported by provider, retrying without response_format');
              continue;
            }
            throw e;
          }
        }
        if (!response) throw lastErr || new Error('LLM request failed');
        logger.info(`[LLM Response] Received response successfully.`);
      } catch (err: any) {
        // Provide more detailed info for Connection Error
        logger.error(`[LLM Error] API Call Failed!`);
        logger.error(`[LLM Error Details] Name: ${err.name}, Message: ${err.message}`);
        if (err.response) {
           logger.error(`[LLM Error Status] ${err.response.status}`);
           logger.error(`[LLM Error Data] ${JSON.stringify(err.response.data || err.response)}`);
        }
        if (err.cause) {
           logger.error(`[LLM Error Cause] ${JSON.stringify(err.cause)}`);
        }
        logger.error(`[LLM Error Stack] ${err.stack}`);
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("No content returned from LLM");
      }

      logger.info(`LLM Raw Output for message ${task.message_id}: ${content}`);
      
      let parsed: any;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        throw new Error(`Failed to parse LLM response as JSON: ${content}`);
      }

      let resultData: AdData[] = [];
      if (Array.isArray(parsed)) {
        resultData = parsed;
      } else if (parsed && typeof parsed === 'object') {
        const keys = Object.keys(parsed);
        for (const key of keys) {
          if (Array.isArray(parsed[key])) {
            resultData = parsed[key];
            break;
          }
        }
        if (resultData.length === 0) {
           logger.warn(`Could not find an array in the JSON object: ${JSON.stringify(parsed)}`);
        }
      }
      
      return resultData;

    } catch (error: any) {
      logger.error(`Error processing image ${task.localPath}:`, error);
      throw error;
    }
  }

  public async reviseRows(rows: any[], instruction: string): Promise<any[]> {
    const settings = getSettings();
    const rawBaseUrl = (process.env.LLM_BASE_URL || settings.llm.baseUrl || '').trim();
    const safeBaseUrl = rawBaseUrl
      .replace(/^`|`$/g, '')
      .replace(/^"|"$/g, '')
      .replace(/^'|'$/g, '')
      .replace(/\/$/, '');
    const apiKey = (process.env.LLM_API_KEY || settings.llm.apiKey || '').trim().replace(/^`|`$/g, '').replace(/^"|"$/g, '').replace(/^'|'$/g, '');
    const model = (process.env.LLM_MODEL || settings.llm.model || '').trim().replace(/^`|`$/g, '').replace(/^"|"$/g, '').replace(/^'|'$/g, '');
    logger.info(`[LLM Config] Calling LLM API via ${safeBaseUrl} with model ${model || settings.llm.model} for revision`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);

    try {
      const client = new OpenAI({
        apiKey,
        baseURL: safeBaseUrl,
        fetch: customFetch as any
      });

      const systemPrompt =
        '你是一个严格的JSON数据修正助手。你将收到一份 rows 数组（每行包含 rowId、渠道名、消耗/U、展示、点击量）以及用户的自然语言修改要求。' +
        '请只做用户明确要求的修改：可以修改数值、修改渠道名、或删除某些行。' +
        '你必须返回 JSON 对象：{"rows":[...]}，并且每一行必须保留 rowId。' +
        '如果用户没有提到某行，就保持该行不变。不要输出任何解释文字。';

      const messages = [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: JSON.stringify({
            rows,
            instruction
          })
        }
      ];

      let response: any = null;
      let lastErr: any = null;
      for (const withResponseFormat of [true, false]) {
        try {
          const req: any = {
            model,
            messages,
            max_tokens: Math.min(1200, settings.llm.maxTokens || 1000),
            temperature: 0
          };
          if (withResponseFormat) req.response_format = { type: 'json_object' };
          response = await client.chat.completions.create(req, { signal: controller.signal as any });
          break;
        } catch (e: any) {
          lastErr = e;
          const status = e?.status || e?.response?.status || e?.response?.statusCode;
          const data = e?.response?.data || e?.response || {};
          const combined = `${e?.message || ''} ${JSON.stringify(data)}`;
          if (withResponseFormat && status === 400 && /response_format|json_object|json schema|invalid_request/i.test(combined)) {
            logger.warn('[LLM] response_format not supported by provider, retrying without response_format');
            continue;
          }
          throw e;
        }
      }
      if (!response && lastErr) throw lastErr;

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error('No content returned from LLM');

      let parsed: any;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        throw new Error(`Failed to parse LLM response as JSON: ${content}`);
      }

      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.rows)) return parsed.rows;
        if (Array.isArray(parsed.data)) return parsed.data;
        const keys = Object.keys(parsed);
        for (const k of keys) {
          if (Array.isArray(parsed[k])) return parsed[k];
        }
      }
      throw new Error(`No array returned from LLM: ${content}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
