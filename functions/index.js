const functions = require('firebase-functions');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { initializeApp } = require('firebase-admin/app');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');



const { sendToSlack, createSlackMessage, listAllChannels, createSlackPinMessage, pinMessage, updatePinnedMessage } = require('./slack');
const { MessageType } = require('./types');
const { getSolPrice } = require('./price');

const DEV_HANDLER = process.env.SLACK_CHANNEL;


initializeApp();
puppeteer.use(StealthPlugin());

// const db = getFirestore('tracker');
// connectFunctionsEmulator(db, '127.0.0.1', 5001);

async function getOrCreateChannelID(db, userAccount) {
  const channelIDRef = db.collection('wallets').doc(userAccount);
  const channelIDObj = await channelIDRef.get();

  if (channelIDObj.exists) {
    const existingID = channelIDObj.data().channelID;
    console.log(`[getOrCreateChannelID] Found existing channel ID=${existingID} for userAccount=${userAccount}`);
    return existingID;
  }

  const allChannels = await listAllChannels();
  const walletLower = userAccount.toLowerCase();
  const foundChannel = allChannels.channels.find(ch => ch.name === walletLower);

  if (!foundChannel) {
    console.warn(`[getOrCreateChannelID] No channel found for userAccount=${walletLower}. Creating or skipping...`);
    return null;
  }

  await channelIDRef.set({ channelID: foundChannel.id });
  return foundChannel.id;
}

async function handleBuyTransaction(db, userAccount, tokenMint) {
  const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
  const docId = `${userAccount}_${tokenMint}`.toLowerCase();
  const docRefRT = db.collection('recentTransactions').doc(docId);

  await docRefRT.set({
    userAccount,
    tokenMint,
    timestampMs: Date.now(),
    expireAt: oneHourFromNow
  }, { merge: true });

  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  const snapshot = await db.collection('recentTransactions')
    .where('tokenMint', '==', tokenMint)
    .where('timestampMs', '>=', oneHourAgo)
    .get();

  const distinctWallets = new Set(snapshot.docs.map(d => d.data().userAccount));

  if (distinctWallets.size > 1) {
    const walletList = Array.from(distinctWallets).join(', ');
    const baseLinks = {
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `<https://neo.bullx.io/terminal?chainId=1399811149&address=${tokenMint}|View on BullX> • ` + 
              `<https://gmgn.ai/sol/token/${tokenMint}|View on GMGN> • ` +
              `<https://gmgn.ai/sol/address/6fm8Nrym_${userAccount}|View User>`
      }]
    };
    const message = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${distinctWallets.size} wallets bought \`${tokenMint}\` within 2 hours!\n\nWallets: ${walletList}`
        }
      },
      baseLinks,
      { type: "divider" }
    ];

    await sendToSlack([message], DEV_HANDLER);
  }
}

async function updateFirestoreAndSlack(db, docRef, channelID, userAccount, tokenMint, timestamp, usdInvestment, isBuy, data, solAmount, amount) {
  const currentQuantity = data.quantity || 0;
  const currentInvestment = data.positionUSD || 0;
  const currentAverageBuyPrice = data.averageBuyPriceSOL || 0;
  let newAverageBuyPrice = currentAverageBuyPrice;

  if (isBuy) {
    newAverageBuyPrice = ((currentAverageBuyPrice * currentQuantity) + (solAmount * parseFloat(amount))) / (currentQuantity + parseFloat(amount));
  }

  const newQuantity = isBuy ? currentQuantity + parseFloat(amount) : currentQuantity - parseFloat(amount);
  // For buys: add to investment, for sells: reduce position value
  const newPosition = isBuy ? currentInvestment - usdInvestment : currentInvestment + usdInvestment;


  await docRef.update({
    quantity: newQuantity,
    positionUSD: newPosition,
    averageBuyPriceSOL: isBuy ? newAverageBuyPrice : currentAverageBuyPrice,
    buyTransactions: isBuy ? data.buyTransactions + 1 : data.buyTransactions,
    sellTransactions: isBuy ? data.sellTransactions : data.sellTransactions + 1,
    lastTransaction: timestamp,
  });

  if (isBuy && data.buyTransactions + 1 === 3) {
    const slackMessage = createSlackMessage(MessageType.THIRD_BUY, { timestamp, usdAmount: -newPosition, tokenMint, userAccount });
    await sendToSlack(slackMessage, channelID, data.ts, true);
    // await sendToSlack(slackMessage, DEV_HANDLER, data.ts, true);
  }

  if (!isBuy) {
    if (newQuantity <= 0.1) {
      const slackMessage = createSlackMessage(MessageType.FULL_SELL, { timestamp, usdAmount: newPosition, tokenMint, userAccount });
      await sendToSlack(slackMessage, channelID, data.ts, false);
      
      
      // Clean up the position document
      await docRef.delete();
    } else if (newQuantity < currentQuantity / 2) {
      const slackMessage = createSlackMessage(MessageType.HALF_SELL, { timestamp, usdAmount: newPosition, tokenMint, userAccount });
      await sendToSlack(slackMessage, channelID, data.ts, false);
    }

    await db.collection('sells').add({
      userAccount,
      createdAt: FieldValue.serverTimestamp(),
      expireAt: new Date(Date.now() + 60 * 60 * 1000)
    })
  }
}

exports.copyTrade = functions.https.onRequest(async (req, res) => {
  try {
    const db = getFirestore('tracker');
    const transactions = req.body;

    if (!transactions || !Array.isArray(transactions)) {
      console.error("Invalid data format:", req.body);
      return res.status(400).send("Invalid data format");
    }

    const solPrice = await getSolPrice();

    for (const transaction of transactions) {
      if (transaction.type !== "SWAP") {
        console.log("Not a SWAP transaction. Ignored.");
        continue;
      }

      const { feePayer: userAccount, events: { swap }, timestamp } = transaction;
      const { tokenInputs = [], tokenOutputs = [], nativeInput = { amount: 0 }, nativeOutput = { amount: 0 } } = swap || {};
      const timestampStr = new Date(timestamp * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true }).split(', ')[1];
      console.log("timestampStr:", timestampStr);

      let tokenMint, amount, solAmount, isBuy = false;

      if (tokenOutputs.length > 0) {
        tokenMint = tokenOutputs[0]?.mint || "Unknown";
        solAmount = nativeInput.amount / 10 ** 9;
        amount = tokenOutputs[0].rawTokenAmount.tokenAmount / 10 ** tokenOutputs[0].rawTokenAmount.decimals;
        isBuy = true;
        handleBuyTransaction(db, userAccount, tokenMint);
      } else if (tokenInputs.length > 0) {
        tokenMint = tokenInputs[0]?.mint || "Unknown";
        solAmount = nativeOutput.amount / 10 ** 9;
        amount = tokenInputs[0].rawTokenAmount.tokenAmount / 10 ** tokenInputs[0].rawTokenAmount.decimals;
      } else {
        console.log("Not a token swap. Ignored.");
        continue;
      }

      const docRef = db.collection(userAccount).doc(tokenMint);
      const doc = await docRef.get();
      const channelID = await getOrCreateChannelID(db, userAccount);

      if (!channelID) {
        console.warn(`No channel ID for userAccount=${userAccount}. Skipping Slack message.`);
        continue;
      }

      const usdInvestment = solAmount * solPrice;

      if (!doc.exists) {
        await docRef.set({
          quantity: parseFloat(amount),
          positionUSD: -usdInvestment,
          averageBuyPriceSOL: isBuy ? solAmount : 0,
          buyTransactions: isBuy ? 1 : 0,
          sellTransactions: isBuy ? 0 : 1,
          lastTransaction: timestampStr,
        });

        const slackMessage = createSlackMessage(MessageType.NEW_POSITION, { timestamp: timestampStr, usdAmount: usdInvestment, tokenMint, userAccount });
        await sendToSlack(slackMessage, channelID).then(res => docRef.set({ ts: res.ts }, { merge: true }));
      } else {
        await updateFirestoreAndSlack(db, docRef, channelID, userAccount, tokenMint, timestampStr, usdInvestment, isBuy, doc.data(), solAmount, amount);
      }
    }

    res.status(200).json({ message: 'Transactions processed successfully' });
  } catch (error) {
    console.error('Error processing transactions:', error);
    res.status(500).send('Internal server error');
  }
});




// exports.onSellTransactionWrite = functions.firestore.onDocumentCreated({
//     document: 'sells/{docId}',
//     database: 'tracker', 
//     memory: "1GiB",
//   }, async (event) => {

//     const db = getFirestore('tracker');
//     const data = event.data.data();
//     const userAccount = data.userAccount;
//     const walletAddress = userAccount;

//     console.log("Scraping coin stats for wallet:", walletAddress);

//     const browser = await puppeteer.launch({
//       headless: 'new',  
//       args: [
//         '--no-sandbox',
//         '--disable-setuid-sandbox',
//         '--disable-dev-shm-usage',
//         '--disable-gpu',
//         '--window-size=1920,1080'
//       ],
//       defaultViewport: { width: 1920, height: 1080 },
//     });
//     const page = await browser.newPage(); 
//     await page.setUserAgent(
//       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.5845.97 Safari/537.36'
//     );
  
//     const url = `https://gmgn.ai/sol/address/${walletAddress}`;
//     const response = await page.goto(url, { waitUntil: 'networkidle2' });
//     console.log('Response status:', response.status());
//     console.log('Response headers:', response.headers());
  
//     // Wait for the script to appear
//     try {
//       await page.waitForSelector('#__NEXT_DATA__', { timeout: 100000 });
//     } catch (error) {
//       console.log('Selector not found, taking screenshot...');
//       await page.screenshot({ path: '/tmp/failed-page.png', fullPage: true });
//       // You could also log the HTML:
//       const content = await page.content();
//       console.log(content);
//       throw error;
//     }
  
//     // Get page content
//     const html = await page.content();
//     const startTag = '<script id="__NEXT_DATA__" type="application/json">';
//     const endTag = '</script>';
//     const startIndex = html.indexOf(startTag);
//     const endIndex = html.indexOf(endTag, startIndex);
//     const jsonText = html.slice(startIndex + startTag.length, endIndex);
    
//     // Parse JSON
//     const nextData = JSON.parse(jsonText);
//     const addressInfo = nextData?.props?.pageProps?.addressInfo;
  
  
    
    
//     await browser.close();
//     const websiteData = {
//       profit_7d: addressInfo.realized_profit_7d,
//       profit_30d: addressInfo.realized_profit_30d,
//       profit: addressInfo.realized_profit,
//       winRate: addressInfo.winrate 
//     };

//     // Reference to the wallet document
//     const channelIDRef = db.collection('wallets').doc(userAccount);

//     // Check if the wallet document exists
//     const docSnapshot = await channelIDRef.get();
//     if (!docSnapshot.exists) {
//       console.log(`Wallet document for user ${userAccount} does not exist.`);
//       return;
//     }

//     // Get the Slack channel ID from Firestore
//     const channelID = docSnapshot.data()?.channelID;
//     if (!channelID) {
//       console.error(`No channelID found for user ${userAccount}.`);
//       return;
//     }

//     // Update the wallet data in Firestore
//     await channelIDRef.update(websiteData);
//     console.log(`Updated wallet data for user: ${userAccount}`);

//     // Handle Slack message (create/update pinned message)
//     const existingMessageTs = docSnapshot.data()?.slackMessageTs; // Check for existing Slack message timestamp

//     if (existingMessageTs) {
//       // Update the existing pinned message
//       const message = createSlackPinMessage(websiteData);
//       const updateResult = await updatePinnedMessage(channelID, existingMessageTs, message);
//       if (!updateResult) {
//         console.error('Failed to update pinned message on Slack.');
//         return;
//       }
//       console.log('Pinned message updated successfully.');
//     } else {
//       // Create and pin a new message
//       const message = createSlackPinMessage(websiteData);
//       const postResult = await sendToSlack(message, channelID);
//       if (!postResult) {
//         console.error('Failed to post message to Slack.');
//         return;
//       }

//       // Pin the message
//       const pinResult = await pinMessage(channelID, postResult.ts);
//       if (!pinResult) {
//         console.error('Failed to pin message to Slack.');
//         return;
//       }

//       // Store the Slack message timestamp in Firestore
//       await channelIDRef.update({ slackMessageTs: postResult.ts });
//       console.log('Profit figures posted, pinned, and timestamp stored successfully.');
//     }
//   }
// );