const { WebClient } = require('@slack/web-api');
const { MessageType } = require('./types');

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL;

function createSlackMessage(type, { timestamp, usdAmount, tokenMint, userAccount }) {
  const baseLinks = {
    type: "context",
    elements: [{
      type: "mrkdwn",
      text: `<https://neo.bullx.io/terminal?chainId=1399811149&address=${tokenMint}|View on BullX> • ` + 
            `<https://gmgn.ai/sol/token/${tokenMint}|View on GMGN> • ` +
            `<https://gmgn.ai/sol/address/6fm8Nrym_${userAccount}|View User>`
    }]
  };

  const messages = {
    [MessageType.NEW_POSITION]: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*🟢 Buy Transaction Detected 🟢* ${timestamp} \n\n` +
                `\`${usdAmount.toFixed(2)} USD\`\n` +
                `\`${tokenMint}\`\n`
        },
      },
      baseLinks,
      { type: "divider" }
    ],
    [MessageType.THIRD_BUY]: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*🔥3rd Buy Transaction Detected!🔥* ${timestamp} \n\n` + 
                `\`${usdAmount.toFixed(2)} USD\`\n`
        }
      },
      baseLinks,
      { type: "divider" }
    ],
    [MessageType.FULL_SELL]: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*💰Sold 100% of Position💰* ${timestamp} \n\n` +
                `\`${usdAmount.toFixed(2)} USD\`\n`
        }
      },
      { type: "divider" }
    ],
    [MessageType.HALF_SELL]: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*🔴Sold 50% or more of Position🔴* ${timestamp} \n\n`
        }
      },
      { type: "divider" }
    ]
  };

  return messages[type];
}

async function sendToSlack(message, channel, parentTs = null, replyBroadcast = null) {
  try {
    if (!SLACK_TOKEN) {
      console.error("Missing SLACK_BOT_TOKEN environment variable.");
      return;
    }
    const client = new WebClient(SLACK_TOKEN);

    const payload = {
      channel: channel,
      text: 'Buy transaction detected',
      blocks: message,
      ...(parentTs && { thread_ts: parentTs }),
      ...(replyBroadcast && { reply_broadcast: true }),
    };

    const result = await client.chat.postMessage(payload);

    // console.log("Slack API send response:", result);
    return result

  } catch (error) {
    console.error("Error sending Slack notification:", error);
    return null;
  }
}

async function listAllChannels() {
  try {
    if (!SLACK_TOKEN) {
      console.error("Missing SLACK_BOT_TOKEN environment variable.");
      return;
    }
    const client = new WebClient(SLACK_TOKEN);

    const result = await client.conversations.list({
      types: 'private_channel, public_channel'
    });

    // console.log("Slack API list response:", result);
    return result

  } catch (error) {
    console.error("Error listing Slack channels:", error);
    return null;
  }
}

async function createChannel(name) {
  try {
    if (!SLACK_TOKEN) {
      console.error("Missing SLACK_BOT_TOKEN environment variable.");
      return;
    }
    const client = new WebClient(SLACK_TOKEN);

    const result = await client.conversations.create({
      name: name,
    });


    // console.log("Slack API create response:", result);
    return result

  } catch (error) {
    console.error("Error creating Slack channel:", error);
    return null;
  }
}

module.exports = {
  sendToSlack,
  createSlackMessage,
  createChannel,
  listAllChannels
};
