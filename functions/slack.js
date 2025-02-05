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

function createSlackPinMessage(walletAddress, { profit_7d, profit_30d, profit, winRate }) {
  const formatNumber = (value) =>
    new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);

  const formatPercent = (value) =>
    new Intl.NumberFormat('en-US', {
      style: 'percent',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);

  const lastUpdated = new Date().toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `Profit Figures for Wallet: ${walletAddress}`,
        emoji: true,
      },
    },

    {
      type: 'divider',
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*7d Profit:*\n$${formatNumber(profit_7d)}`,
        },
        {
          type: 'mrkdwn',
          text: `*30d Profit:*\n$${formatNumber(profit_30d)}`,
        },
        {
          type: 'mrkdwn',
          text: `\n*Total Profit:*\n$${formatNumber(profit)}`,
        },
        {
          type: 'mrkdwn',
          text: `\n*Win Rate:*\n${formatPercent(winRate)}`,
        },
      ],
    },
    {
      type: 'divider',
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Keep crushing it! :moneybag:`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Last updated: ${lastUpdated}`,
        },
      ],
    },
  ];
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
      text: 'Transaction detected',
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

async function pinMessage(channel, messageTs) {
  try {
    if (!SLACK_TOKEN) {
      console.error('Missing SLACK_BOT_TOKEN environment variable.');
      return null;
    }
    const client = new WebClient(SLACK_TOKEN);

    const result = await client.pins.add({
      channel: channel,
      timestamp: messageTs,
    });

    return result;

  } catch (error) {
    console.error('Error pinning Slack message:', error);
    return null;
  }
}

async function updatePinnedMessage(channel, messageTs, newMessage) {
  try {
    if (!SLACK_TOKEN) {
      console.error('Missing SLACK_BOT_TOKEN environment variable.');
      return null;
    }
    const client = new WebClient(SLACK_TOKEN);

    const result = await client.chat.update({
      channel: channel,
      ts: messageTs,
      text: 'Profit Update',
      blocks: newMessage,
    });

    return result;

  } catch (error) {
    console.error('Error updating Slack message:', error);
    return null;
  }
}

module.exports = {
  sendToSlack,
  createSlackMessage,
  createChannel,
  listAllChannels,
  createSlackPinMessage,
  pinMessage,
  updatePinnedMessage
};
