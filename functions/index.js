const functions = require('firebase-functions');
const { getFirestore } = require("firebase-admin/firestore");
const { initializeApp } = require("firebase-admin/app");
const { WebClient } = require('@slack/web-api');
const fetch = require('node-fetch');
const app = initializeApp();
const db = getFirestore('tracker');
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL;

async function getSolPrice() {
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const data = await response.json();
    return data.solana.usd;
  } catch (error) {
    console.log("Error fetching SOL price, falling back to hardcoded value", error);
    return 250;
    // console.error("Error fetching SOL price:", error);
    // throw new Error("Unable to fetch SOL price at this time.");
  }
}

async function sendToSlack(message, parentTs = null, replyBroadcast = null) {
  try {
    if (!SLACK_TOKEN) {
      console.error("Missing SLACK_BOT_TOKEN environment variable.");
      return;
    }
    const client = new WebClient(SLACK_TOKEN);

    const payload = {
      channel: SLACK_CHANNEL,
      text: 'Buy transaction detected',
      blocks: message,
      ...(parentTs && { thread_ts: parentTs }),
      ...(replyBroadcast && { reply_broadcast: true }),
    };

    const result = await client.chat.postMessage(payload);

    console.log("Slack API response:", result);
    return result

  } catch (error) {
    console.error("Error sending Slack notification:", error);
    return null;
  }
}

exports.copyTrade = functions.https.onRequest(async (req, res) => {
  try {

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

      const usdInvestment = solAmount * solPrice;
      const docRef = db.collection(userAccount).doc(tokenMint);
      const doc = await docRef.get();



      if (!doc.exists) {
        await docRef.set({
          quantity: parseFloat(amount),
          positionUSD: -usdInvestment,
          averageBuyPriceSOL: isBuy ? solAmount : 0,
          buyTransactions: isBuy ? 1 : 0,
          sellTransactions: isBuy ? 0 : 1,
          lastTransaction: timestamp,
        });

        const slackMessage = [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*🟢 Buy Transaction Detected 🟢* ${timestamp} \n\n` +
              `\`${usdInvestment.toFixed(2)} USD\`\n` +
              `\`${tokenMint}\`\n` 
              
              
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `<https://neo.bullx.io/terminal?chainId=1399811149&address=${tokenMint}|View on BullX> • ` + 
                `<https://gmgn.ai/sol/token/${tokenMint}|View on GMGN> • ` +
                `<https://gmgn.ai/sol/address/6fm8Nrym_${userAccount}|View User>`
                
              }
            ]
          },
          {
            type: "divider"
          }
        ];
        let res = await sendToSlack(slackMessage, null);
        await docRef.set({ts: res.ts}, {merge: true});

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
          const slackMessage = [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*🔥3rd Buy Transaction Detected!🔥* ${timestamp} \n\n` + 
                `\`${-newPosition.toFixed(2)} USD\`\n`
              }
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `<https://neo.bullx.io/terminal?chainId=1399811149&address=${tokenMint}|View on BullX> • ` + 
                  `<https://gmgn.ai/sol/token/${tokenMint}|View on GMGN> • ` +
                  `<https://gmgn.ai/sol/address/6fm8Nrym_${userAccount}|View User>`
                  
                }
              ]
            },
            {
              type: "divider"
            }
          ];
          await sendToSlack(slackMessage, data.ts, true);
        }

        if (!isBuy && newQuantity <= 0.1) {
            const slackMessage = [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `*💰Sold 100% of Position💰* ${timestamp} \n\n` +
                    `\`${newPosition.toFixed(2)} USD\`\n`
                  }
                },
                {
                  type: "divider"
                },
    
              ];
              await sendToSlack(slackMessage, data.ts, false);
              await docRef.delete();
        }
        else if (!isBuy && newQuantity < currentQuantity / 2) {
          const slackMessage = [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*🔴Sold 50% or more of Position🔴* ${timestamp} \n\n`
              }
            },
            {
              type: "divider"
            },
        

          ];
          await sendToSlack(slackMessage, data.ts, false);
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