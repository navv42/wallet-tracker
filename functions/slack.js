const { WebClient } = require('@slack/web-api');

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL;

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

module.exports = {
  sendToSlack
};
