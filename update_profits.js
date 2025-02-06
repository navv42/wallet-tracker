const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { initializeApp } = require("firebase-admin/app");

const {
  sendToSlack,
  createSlackMessage,
  listAllChannels,
  createSlackPinMessage,
  pinMessage,
  updatePinnedMessage,
} = require("./functions/slack");

initializeApp();

puppeteer.use(StealthPlugin());

// Scrape function remains the same
async function scrape(walletAddress) {
  console.log("Scraping coin stats for wallet:", walletAddress);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1920,1080",
    ],
    defaultViewport: { width: 1920, height: 1080 },
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.5845.97 Safari/537.36"
  );

  const url = `https://gmgn.ai/sol/address/${walletAddress}`;
  const response = await page.goto(url, { waitUntil: "networkidle2" });
  console.log("Response status:", response.status());


  // Wait for the script to appear
  try {
    await page.waitForSelector("#__NEXT_DATA__", { timeout: 100000 });
  } catch (error) {
    console.log("Selector not found, taking screenshot...");
    await page.screenshot({ path: "/tmp/failed-page.png", fullPage: true });
    const content = await page.content();
    console.log(content);
    throw error;
  }

  // Get page content
  const html = await page.content();
  const startTag = '<script id="__NEXT_DATA__" type="application/json">';
  const endTag = "</script>";
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
    winRate: addressInfo.winrate,
  };
}

// Updated updateSlack to accept userAccount and websiteData explicitly
async function updateSlack(db, userAccount, websiteData) {
  // Reference to the wallet document
  const channelIDRef = db.collection("wallets").doc(userAccount);

  // Check if the wallet document exists
  const docSnapshot = await channelIDRef.get();
  if (!docSnapshot.exists) {
    console.log(`Wallet document for user ${userAccount} does not exist.`);
    return;
  }

  // Get the Slack channel ID from Firestore
  const channelID = docSnapshot.data()?.channelID;
  if (!channelID) {
    console.error(`No channelID found for user ${userAccount}.`);
    return;
  }

  // Update the wallet data in Firestore
  await channelIDRef.update(websiteData);
  console.log(`Updated wallet data for user: ${userAccount}`);

  // Handle Slack message (create/update pinned message)
  const existingMessageTs = docSnapshot.data()?.slackMessageTs; // Check for existing Slack message timestamp

//   if (existingMessageTs) {
//     // Update the existing pinned message
//     const message = createSlackPinMessage(userAccount, websiteData);
//     const updateResult = await updatePinnedMessage(channelID, existingMessageTs, message);
//     if (!updateResult) {
//       console.error("Failed to update pinned message on Slack.");
//       return;
//     }
//     console.log("Pinned message updated successfully.");
//   } else {
    // Create and pin a new message
    const message = createSlackPinMessage(userAccount, websiteData);
    const postResult = await sendToSlack(message, channelID);
    if (!postResult) {
        console.error("Failed to post message to Slack.");
        return;
    }

    // Pin the message
    const pinResult = await pinMessage(channelID, postResult.ts);
    if (!pinResult) {
        console.error("Failed to pin message to Slack.");
        return;
    }

    // Store the Slack message timestamp in Firestore
    await channelIDRef.update({ slackMessageTs: postResult.ts });
console.log("Profit figures posted, pinned, and timestamp stored successfully.");
//   }
}

async function main() {
    const db = getFirestore("tracker");
  
    try {
      // Fetch all docs from 'wallets'
      const walletRef = db.collection("wallets");
      const snapshot = await walletRef.get();
  
      if (snapshot.empty) {
        console.log("No wallet documents found.");
        return;
      }
  
      // Iterate over each wallet doc
      for (const doc of snapshot.docs) {
        // doc.id is the wallet address
        const walletAddress = doc.id;
        const data = doc.data();
  
        // If there's no channelID, skip
        if (!data.channelID) {
          console.log(`Skipping wallet ${walletAddress}, no channelID field found.`);
          continue;
        }
  
        try {
          // 1) Scrape data for this wallet
          const websiteData = await scrape(walletAddress);
  
          // 2) Update Slack (and Firestore) with the new data
          await updateSlack(db, walletAddress, websiteData);
  
        } catch (err) {
          console.error(`Error processing wallet ${walletAddress}:`, err);
        }

        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    } catch (error) {
      console.error("Error in main:", error);
    } finally {
      console.log("Done processing all wallets.");
    }
  }
  
  if (require.main === module) {
    main();
  }
