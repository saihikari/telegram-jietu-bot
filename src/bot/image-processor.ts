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
  rejectUnauthorized: false // Sometimes proxy certs cause issues
});

// Use native node-fetch like behavior but via a wrapper that enforces the custom agent
const customFetch = async (url: any, init?: any): Promise<any> => {
  const options = {
    ...init,
    agent: httpsAgent
  };
  // We use node-fetch under the hood which is what OpenAI SDK expects
  const nodeFetch = require('node-fetch');
  return nodeFetch(url, options);
};

// remove getClient as it's no longer used
export class ImageProcessor {
  public async processImage(task: ImageTask): Promise<AdData[]> {
    if (!task.localPath || !fs.existsSync(task.localPath)) {
      throw new Error(`Image not found: ${task.localPath}`);
    }

    const settings = getSettings();
    // Use our custom fetch with custom https.Agent
    const client = new OpenAI({
      apiKey: process.env.LLM_API_KEY || settings.llm.apiKey,
      baseURL: process.env.LLM_BASE_URL || settings.llm.baseUrl,
      fetch: customFetch as any
    });
    
    try {
      const base64Image = fs.readFileSync(task.localPath, 'base64');
      const dataUrl = `data:image/jpeg;base64,${base64Image}`;

      // Optional: Log LLM configuration for debugging
      logger.info(`Calling LLM API via ${client.baseURL} with model ${settings.llm.model}`);

      // We pass an abort signal to the fetch call inside openai to prevent hanging
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout for LLM

      let response;
      try {
        // OpenAI SDK uses node-fetch internally which defaults to node 18's fetch.
        // The fetch options pass an abort signal.
        response = await client.chat.completions.create({
          model: process.env.LLM_MODEL || settings.llm.model,
          messages: [
            { role: "system", content: settings.llm.systemPrompt },
            { role: "user", content: [
              { type: "text", text: "请识别这张截图中的广告数据：" },
              { type: "image_url", image_url: { url: dataUrl } }
            ] }
          ],
          max_tokens: settings.llm.maxTokens,
          temperature: settings.llm.temperature,
          response_format: { type: "json_object" }
        }, { signal: controller.signal as any });
      } catch (err: any) {
        // Provide more detailed info for Connection Error
        logger.error(`OpenAI Connection Error Details: URL=${client.baseURL}, Key Length=${client.apiKey?.length}, Error=${err.message}`);
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
}
