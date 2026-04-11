const https = require('https');
const nodeFetch = require('node-fetch');

const httpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false,
  family: 4
});

const url = 'https://api.chatanywhere.tech/v1/chat/completions';
const options = {
  method: 'POST',
  agent: httpsAgent,
  family: 4,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'OpenAI/NodeJS/4.104.0',
    'Authorization': 'Bearer test'
  },
  body: JSON.stringify({
    model: 'gpt-3.5-turbo',
    messages: [{ role: 'user', content: 'hello' }]
  })
};

nodeFetch(url, options)
  .then(async (res) => {
    console.log('Status:', res.status);
    console.log('Body:', await res.text());
  })
  .catch((err) => {
    console.error('Error:', err);
  });
