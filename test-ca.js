const fetch = require('node-fetch');
async function test() {
  const res = await fetch('https://api.chatanywhere.tech/v1/dashboard/billing/subscription', {
    headers: { 'Authorization': 'Bearer sk-mQQO6n2P2pM512z3H15cE018Ae9a4bF28e93DeC4459dbd8g' }
  });
  console.log(await res.text());
}
test();
