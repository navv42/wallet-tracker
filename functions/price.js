const fetch = require('node-fetch');

async function getSolPrice() {
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const data = await response.json();
    return data.solana.usd;
  } catch (error) {
    console.log("Error fetching SOL price, falling back to hardcoded value", error);
    return 190;
  }
}

module.exports = {
  getSolPrice
};
