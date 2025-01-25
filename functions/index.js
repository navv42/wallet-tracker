const functions = require('firebase-functions');
const { getFirestore } = require("firebase-admin/firestore");
const { initializeApp } = require("firebase-admin/app");
const { sendToSlack } = require('./slack');
const { getSolPrice } = require('./price');
const app = initializeApp();
const db = getFirestore('tracker');


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
