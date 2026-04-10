import fs from 'fs';
import path from 'path';
import { OpenAI } from 'openai';
import { getSettings } from '../utils/config';
import { AdData, ImageTask } from '../types';
import logger from '../utils/logger';

export class ImageProcessor {
  private getClient(): OpenAI {
    const settings = getSettings();
    return new OpenAI({
      apiKey: process.env.LLM_API_KEY || settings.llm.apiKey,
      baseURL: process.env.LLM_BASE_URL || settings.llm.baseUrl,
    });
  }

  public async processImage(task: ImageTask): Promise<AdData[]> {
    if (!task.localPath || !fs.existsSync(task.localPath)) {
      throw new Error(`Image not found: ${task.localPath}`);
    }

    const settings = getSettings();
    const client = this.getClient();
    
    try {
      const base64Image = fs.readFileSync(task.localPath, 'base64');
      const dataUrl = `data:image/jpeg;base64,${base64Image}`;

      // Optional: Log LLM configuration for debugging
      logger.info(`Calling LLM API via ${client.baseURL} with model ${settings.llm.model}`);

      // We pass an abort signal to the fetch call inside openai to prevent hanging
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

      let response;
      try {
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

      // Check if response has an array format like { "data": [...] } or is just an array.
      // We asked for an array, but with json_object it might return { "results": [...] } or similar.
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
           // Fallback to return empty array
        }
      }
      
      return resultData;

    } catch (error: any) {
      logger.error(`Error processing image ${task.localPath}:`, error);
      throw error;
    }
  }
}
