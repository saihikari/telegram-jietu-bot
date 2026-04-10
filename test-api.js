const https = require('https');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

const nodeFetch = require('node-fetch');

const httpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false,
  family: 4
});

async function test() {
  const baseUrl = (process.env.LLM_BASE_URL || 'https://api.chatanywhere.tech/v1').replace(/\/$/, '');
  const apiKey = process.env.LLM_API_KEY || 'sk-test';
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';

  console.log('--- 测试 API 连通性 ---');
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Model: ${model}`);
  console.log(`API Key: ${apiKey.substring(0, 5)}***`);

  const url = `${baseUrl}/chat/completions`;
  const options = {
    method: 'POST',
    agent: httpsAgent,
    family: 4,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'OpenAI/NodeJS/4.104.0',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: 'Hello, are you there?' }],
      max_tokens: 10
    })
  };

  console.log(`正在请求: ${url}`);
  try {
    const res = await nodeFetch(url, options);
    console.log(`状态码: ${res.status}`);
    const text = await res.text();
    console.log(`响应内容: ${text}`);
  } catch (err) {
    console.error(`请求失败! 错误类型: ${err.name}`);
    console.error(`错误详情: ${err.message}`);
    console.error(err);
  }
}

test();
