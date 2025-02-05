const puppeteer = require("puppeteer");

/**
 * Scrape the Next.js data for the specified wallet.
 * Example: "687kTFNvKG9GXf8UsPzyrKbKpz5ExNrSCWfs7S4PTGiL"
 */
async function scrapeWalletStats(db, walletAddress) {
    console.log("Scraping coin stats for wallet:", walletAddress);
  // This is the page you mentioned
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ],
  });
//   const browser = await puppeteer.launch({
//     executablePath: chromium.executablePath, // Provide the path to Chromium
//     headless: false,
//     args: chromium.args,           // Recommended args for the serverless environment
//     defaultViewport: chromium.defaultViewport,
//   });
  const page = await browser.newPage(); 

  const url = `https://gmgn.ai/sol/address/${walletAddress}`;
  await page.goto(url, { waitUntil: 'networkidle2' });

  // Wait for the script to appear
  await page.waitForSelector('#__NEXT_DATA__', { timeout: 100000 });

  // Get page content
  const html = await page.content();
  const startTag = '<script id="__NEXT_DATA__" type="application/json">';
  const endTag = '</script>';
  const startIndex = html.indexOf(startTag);
  const endIndex = html.indexOf(endTag, startIndex);
  const jsonText = html.slice(startIndex + startTag.length, endIndex);
  
  // Parse JSON
  const nextData = JSON.parse(jsonText);
  const addressInfo = nextData?.props?.pageProps?.addressInfo;


  
  
  await browser.close();
  return {
    profit_7d: addressInfo.realized_profit_7d,
    profit_30d: addressInfo.realized_profit_30d,
    profit: addressInfo.realized_profit,
    winRate: addressInfo.winrate 
  };
}

module.exports = {
    scrapeWalletStats
  };

