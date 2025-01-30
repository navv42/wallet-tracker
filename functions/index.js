const functions = require('firebase-functions');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { initializeApp } = require('firebase-admin/app');

const { sendToSlack, createSlackMessage, listAllChannels } = require('./slack');
const { MessageType } = require('./types');
const { getSolPrice } = require('./price');

const DEV_HANDLER = process.env.SLACK_CHANNEL;

initializeApp();

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
    const message = {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Coordinated Buy Alert*\nTwo wallets bought \`${tokenMint}\` within 2 hours!`
      }
    };

    // await sendToSlack([message], DEV_HANDLER);
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
  
  // Track total amount invested
  let totalInvestment = data.totalInvestment || 0;
  if (isBuy) {
    totalInvestment += usdInvestment;
  }

  // Calculate profit and percentage gain for sell transactions
  let totalProfit = data.totalProfit || 0;
  let percentageGain = data.percentageGain || 0;

  if (!isBuy) {
    // Calculate profit based on the portion of position being sold
    const soldPortion = parseFloat(amount) / currentQuantity;
    const costBasis = Math.abs(currentInvestment * soldPortion); // Use currentInvestment as it represents the negative of what was spent
    const saleProceeds = usdInvestment;
    const profitFromSell = saleProceeds + costBasis; // Add because currentInvestment is negative
    
    totalProfit += profitFromSell;
    percentageGain = totalInvestment > 0 ? ((totalProfit / Math.abs(totalInvestment)) * 100).toFixed(2) : 0;
    
    // Reduce total investment proportionally when selling
    totalInvestment = totalInvestment * (1 - soldPortion);
  }

  await docRef.update({
    quantity: newQuantity,
    positionUSD: newPosition,
    averageBuyPriceSOL: isBuy ? newAverageBuyPrice : currentAverageBuyPrice,
    buyTransactions: isBuy ? data.buyTransactions + 1 : data.buyTransactions,
    sellTransactions: isBuy ? data.sellTransactions : data.sellTransactions + 1,
    lastTransaction: timestamp,
    totalProfit: !isBuy ? totalProfit : data.totalProfit, // Update total profit only for sells
    totalInvestment: !isBuy ? totalInvestment : data.totalInvestment, // Update total investment only for sells
    percentageGain: !isBuy ? percentageGain : data.percentageGain, // Update percentage gain only for sells
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
      
      // Update wallet's total profit only on full position close
      const walletRef = db.collection('wallets').doc(userAccount);
      const walletDoc = await walletRef.get();
      const existingProfit = walletDoc.exists ? (walletDoc.data().profit || 0) : 0;
      await walletRef.set({
        profit: existingProfit + totalProfit,
        lastUpdated: FieldValue.serverTimestamp()
      }, { merge: true });
      
      // Clean up the position document
      // await docRef.delete();
    } else if (newQuantity < currentQuantity / 2) {
      const slackMessage = createSlackMessage(MessageType.HALF_SELL, { timestamp, usdAmount: newPosition, tokenMint, userAccount });
      await sendToSlack(slackMessage, channelID, data.ts, false);
    }
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
