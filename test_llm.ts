import fs from 'fs';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import https from 'https';

dotenv.config();

const httpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false,
  family: 4
});

const customFetch = async (url: any, init: any): Promise<any> => {
  const options = {
    ...init,
    agent: httpsAgent,
    headers: {
      ...init?.headers,
      'Accept': 'application/json',
      'User-Agent': 'OpenAI/NodeJS/4.104.0'
    },
    family: 4
  };
  const nodeFetch = require('node-fetch');
  try {
    console.log(`[TEST] Fetching ${url} with method ${init?.method || 'GET'}`);
    return await nodeFetch(url, options);
  } catch (err: any) {
    console.error(`[TEST] Fetch Error:`, err);
    throw err;
  }
};

async function test() {
  console.log('Testing LLM Connection...');
  const baseUrl = (process.env.LLM_BASE_URL || 'https://api.chatanywhere.tech/v1').replace(/\/$/, '');
  const apiKey = process.env.LLM_API_KEY || 'sk-test';
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';

  console.log(`Base URL: ${baseUrl}`);
  console.log(`Model: ${model}`);
  console.log(`API Key: ${apiKey.substring(0, 5)}...`);

  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl,
    fetch: customFetch as any
  });

  try {
    console.log('Sending simple text prompt to check connection...');
    const res = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Hello, are you there?' }],
      max_tokens: 10
    });
    console.log('Text Response:', res.choices[0].message.content);
    console.log('Text test PASSED.');
  } catch (err: any) {
    console.error('Text test FAILED:', err.message);
    if (err.cause) console.error('Cause:', err.cause);
  }
}

test();
