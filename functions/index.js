const functions = require('firebase-functions');
const { getFirestore } = require("firebase-admin/firestore");
const { initializeApp } = require("firebase-admin/app");

const { sendToSlack, createSlackMessage, createChannel, listAllChannels } = require('./slack');
const { MessageType } = require('./types');
const { getSolPrice } = require('./price');

const DEV_HANDLER = process.env.SLACK_CHANNEL;

initializeApp();

exports.copyTrade = functions.https.onRequest(async (req, res) => {
  try {
    const db = getFirestore('tracker');

    const transactions = req.body;

    // console.log("Request Object:", JSON.stringify(transactions, null, 2)); 

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
      const userAccount = transaction.feePayer;
      const tokenInputs = transaction.events.swap?.tokenInputs || [];
      const tokenOutputs = transaction.events.swap?.tokenOutputs || [];
      const nativeInput = transaction.events.swap?.nativeInput?.amount || 0;
      const nativeOutput = transaction.events.swap?.nativeOutput?.amount || 0;
      const timestamp = new Date(transaction.timestamp * 1000).toLocaleString('en-US', {
        timeZone: 'America/New_York',
        hour12: true,
      }).split(', ')[1];

      let tokenMint, amount, solAmount, positionUSD;
      let isBuy = false;

      if (tokenOutputs.length > 0) {
        tokenMint = tokenOutputs[0]?.mint || "Unknown";
        solAmount = nativeInput / 10 ** 9;
        amount = tokenOutputs[0].rawTokenAmount.tokenAmount / 10 ** tokenOutputs[0].rawTokenAmount.decimals;
        isBuy = true;
      } else if (tokenInputs.length > 0) {
        tokenMint = tokenInputs[0]?.mint || "Unknown";
        solAmount = nativeOutput / 10 ** 9;
        amount = tokenInputs[0].rawTokenAmount.tokenAmount / 10 ** tokenInputs[0].rawTokenAmount.decimals;
      } else {
        console.log("Not a token swap. Ignored.");
        continue;
      }

      
      const docRef = db.collection(userAccount).doc(tokenMint);
      const doc = await docRef.get();
      
      const channelIDRef = db.collection('wallets').doc(userAccount);
      const channelIDObj = await channelIDRef.get();
      let channelID = ""

      if (!channelIDObj.exists) {
        const allChannels = await listAllChannels();
        let channel_ID = allChannels.channels.find(channel => channel.name === userAccount.toLowerCase());

        // if (!channel_ID) {
        //   await createChannel(userAccount.toLowerCase());
        //   const allChannels = await listAllChannels();
        //   channel_ID = allChannels.channels.find(channel => channel.name === userAccount.toLowerCase());
        // }
        
        await channelIDRef.set({
          channelID: channel_ID.id
        });
        channelID = channel_ID.id
      }

      if (isBuy) {
        const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
        const docId = `${userAccount}_${tokenMint}`.toLowerCase(); 
        const docRefRT = db.collection('recentTransactions').doc(docId);
        await docRefRT.set({
          userAccount,
          tokenMint,
          timestampMs: Date.now(),
          expireAt: oneHourFromNow  // for TTL
        }, { merge: true });

        const oneHourAgo = Date.now() - (1 * 60 * 60 * 1000);

        // Query all recent buys for this same token in the last 2 hours
        const snapshot = await db.collection('recentTransactions')
          .where('tokenMint', '==', tokenMint)
          .where('timestampMs', '>=', oneHourAgo)
          .get();

        const docs = snapshot.docs.map(d => d.data());
        const distinctWallets = new Set(docs.map(d => d.userAccount));
        // Filter out the *current* user so we only see other wallets

        // If there's at least one other wallet that bought the same token, send Slack alert
        if (distinctWallets.size > 1) {
          // Create a message or block
          const message = {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Coordinated Buy Alert*\nTwo wallets bought \`${tokenMint}\` within 2 hours!`
            }
          };

          // Post to your "coordinated buys" Slack channel 
          await sendToSlack(
            [message],
            DEV_HANDLER 
          );
        }
      }


      const usdInvestment = solAmount * solPrice;

      if (!doc.exists) {
        await docRef.set({
          quantity: parseFloat(amount),
          positionUSD: -usdInvestment,
          averageBuyPriceSOL: isBuy ? solAmount : 0,
          buyTransactions: isBuy ? 1 : 0,
          sellTransactions: isBuy ? 0 : 1,
          lastTransaction: timestamp,
        });

        const slackMessage = createSlackMessage(MessageType.NEW_POSITION, {
          timestamp,
          usdAmount: usdInvestment,
          tokenMint,
          userAccount
        });
        sendToSlack(slackMessage, channelID, null, null)
        .then(res => docRef.set({ ts: res.ts }, { merge: true })); 
      } else {
        const data = doc.data();
        const currentQuantity = data.quantity || 0;
        const currentInvestment = data.positionUSD || 0;
        const currentAverageBuyPrice = data.averageBuyPriceSOL || 0;
        let newAverageBuyPrice = currentAverageBuyPrice;
        
        if (isBuy) {
          newAverageBuyPrice = ((currentAverageBuyPrice * currentQuantity) + (solAmount * parseFloat(amount))) / (currentQuantity + parseFloat(amount));
        }

        const newQuantity = isBuy ? currentQuantity + parseFloat(amount) : currentQuantity - parseFloat(amount);
        const newPosition = isBuy ? currentInvestment - usdInvestment : currentInvestment + usdInvestment;

        await docRef.update({
          quantity: newQuantity,
          positionUSD: newPosition,
          averageBuyPriceSOL: isBuy ? newAverageBuyPrice : currentAverageBuyPrice,
          buyTransactions: isBuy ? data.buyTransactions + 1 : data.buyTransactions,
          sellTransactions: isBuy ? data.sellTransactions : data.sellTransactions + 1,
          lastTransaction: timestamp,
        });

        if (data.buyTransactions + 1 == 3 && isBuy) {
          const slackMessage = createSlackMessage(MessageType.THIRD_BUY, {
            timestamp,
            usdAmount: -newPosition,
            tokenMint,
            userAccount
          });
          await sendToSlack(slackMessage, channelID, data.ts, true);
          await sendToSlack(slackMessage, DEV_HANDLER, data.ts, true);
        }

        if (!isBuy && newQuantity <= 0.1) {
            const slackMessage = createSlackMessage(MessageType.FULL_SELL, {
              timestamp,
              usdAmount: newPosition,
              tokenMint,
              userAccount
            });
            await sendToSlack(slackMessage, data.ts, false)
              .then(() => docRef.delete());
            await channelIDRef.update({
                profit: channelIDObj.data().profit + newPosition
              });
        }
        else if (!isBuy && newQuantity < currentQuantity / 2) {
          const slackMessage = createSlackMessage(MessageType.HALF_SELL, {
            timestamp,
            usdAmount: newPosition,
            tokenMint,
            userAccount
          });
          await sendToSlack(slackMessage, channelID, data.ts, false);
        //   console.log(`User ${userAccount} sold 100% of ${tokenMint}. Profit: $${newPosition.toFixed(3)}`);

        }
      }
    }

    res.status(200).json({ message: 'Transactions processed successfully' });
  } catch (error) {
    console.error('Error processing transactions:', error);
    res.status(500).send('Internal server error');
  }
});
