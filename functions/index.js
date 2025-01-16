const functions = require('firebase-functions');
const { getFirestore } = require("firebase-admin/firestore");
const { initializeApp } = require("firebase-admin/app");
const fetch = require('node-fetch');
const app = initializeApp();
const db = getFirestore('tracker');
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

async function getSolPrice() {
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const data = await response.json();
    return data.solana.usd;
  } catch (error) {
    console.error("Error fetching SOL price:", error);
    throw new Error("Unable to fetch SOL price at this time.");
  }
}

async function sendToSlack(message) {
  try {

    if (!SLACK_WEBHOOK_URL) {
      console.warn("No Slack Webhook URL configured.");
      return;
    }

    const payload = {
      blocks: message
    };

    const response = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error("Failed to send Slack message:", await response.text());
      return null;
    }

    console.log("Slack notification sent.");
    return response.ok ? Date.now() / 1000 : null;  // Return current timestamp if successful
  } catch (error) {
    console.error("Error sending Slack notification:", error);
    return null;
  }
}

exports.copyTrade = functions.https.onRequest(async (req, res) => {
  try {

    const transactions = req.body;
    // Log the full request object
    console.log("Request Object:", JSON.stringify(transactions, null, 2));  // Pretty-printing for better readability

    // Check if 'events' and 'swap' exist before accessing 'tokenOutputs'
    if (transactions.events && transactions.events.swap) {
      console.log("Events Swap Object:", JSON.stringify(transactions.events.swap, null, 2));
      console.log("Token Outputs:", transactions.events.swap.tokenOutputs[0] || "could not find tokenOutputs");
    } else {
      console.log("Swap object not found in events.");
    }


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
        hour12: false,
      });

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
              text: `*🟢Buy Transaction Detected🟢*\n\n
              *User*: ${userAccount}\n
              *Spent*: ${usdInvestment.toFixed(2)} USD\n
              *Token*: <https://gmgn.ai/sol/token/${tokenMint}|${tokenMint}>\n
              *Timestamp*: ${timestamp}`
            }
          },
          {
            type: "divider"
            },
        ];
        await sendToSlack(slackMessage);

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
                text: `*🔥3rd Buy Transaction in a Row Detected!🔥*\n\n
                *User*: ${userAccount}\n
                *Token*: <https://gmgn.ai/sol/token/${tokenMint}|${tokenMint}>\n
                *Current Investment*: ${(-newPosition).toFixed(2)} USD\n
                *Timestamp*: ${timestamp}`
              }
            },
            {
              type: "divider"
            }
          ];
          await sendToSlack(slackMessage);
        }

        if (!isBuy && newQuantity <= 0.1) {
            const slackMessage = [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `*💰Sold 100% of Position💰*\n\n
                    *User*: ${userAccount}\n
                    *Token*: <https://gmgn.ai/sol/token/${tokenMint}|${tokenMint}>\n
                    *Profit*: ${newPosition.toFixed(3)} USD\n
                    *Timestamp*: ${timestamp}`
                  }
                },
                {
                  type: "divider"
                },
    
              ];
              await sendToSlack(slackMessage);
              await docRef.delete();
        }
        else if (!isBuy && newQuantity < currentQuantity / 2) {
          const slackMessage = [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*🔴Sold 50% or more of Position🔴*\n\n
                *User*: ${userAccount}\n
                *Token*: <https://gmgn.ai/sol/token/${tokenMint}|${tokenMint}>\n
                *Timestamp*: ${timestamp}`
              }
            },
            {
              type: "divider"
            },
        

          ];
          await sendToSlack(slackMessage);
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