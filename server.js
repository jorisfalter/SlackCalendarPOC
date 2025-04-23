const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const crypto = require("crypto");
const mongoose = require("mongoose");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

// MongoDB setup
mongoose.connect(process.env.MONGO_URI);
const User = mongoose.model(
  "User",
  new mongoose.Schema({
    slackUserId: String,
    accessToken: String,
    refreshToken: String,
  })
);

// Verify Slack signature
function verifySlackRequest(req) {
  const timestamp = req.headers["x-slack-request-timestamp"];
  const sigBaseString = `v0:${timestamp}:${JSON.stringify(req.body)}`;
  const mySig =
    "v0=" +
    crypto
      .createHmac("sha256", process.env.SLACK_SIGNING_SECRET)
      .update(sigBaseString)
      .digest("hex");
  const slackSig = req.headers["x-slack-signature"];
  return crypto.timingSafeEqual(Buffer.from(mySig), Buffer.from(slackSig));
}

// Slack event handler
app.post("/slack/events", async (req, res) => {
  const { type, challenge, event } = req.body;
  if (type === "url_verification") return res.send(challenge);
  if (!verifySlackRequest(req))
    return res.status(400).send("Invalid signature");

  if (event && event.type === "message" && !event.bot_id) {
    const slackUserId = event.user;
    const user = await User.findOne({ slackUserId });

    if (!user) {
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${process.env.GOOGLE_REDIRECT_URI}&response_type=code&scope=https://www.googleapis.com/auth/calendar.events&access_type=offline&prompt=consent&state=${slackUserId}`;
      await axios.post(
        "https://slack.com/api/chat.postMessage",
        {
          channel: event.channel,
          text: `Please connect your Google Calendar: ${authUrl}`,
        },
        {
          headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        }
      );
      return res.sendStatus(200);
    }

    // Example: create event at fixed time (replace with parsing logic)
    const start = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now
    const end = new Date(Date.now() + 7200000).toISOString(); // 2 hours from now

    await axios.post(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      {
        summary: "Blocked time",
        start: { dateTime: start },
        end: { dateTime: end },
      },
      {
        headers: { Authorization: `Bearer ${user.accessToken}` },
      }
    );

    await axios.post(
      "https://slack.com/api/chat.postMessage",
      {
        channel: event.channel,
        text: `✅ Event added to your Google Calendar!`,
      },
      {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      }
    );
  }

  res.sendStatus(200);
});

// OAuth redirect handler
app.get("/google/oauth/callback", async (req, res) => {
  const { code, state } = req.query;
  const { data } = await axios.post("https://oauth2.googleapis.com/token", {
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    grant_type: "authorization_code",
  });

  await User.findOneAndUpdate(
    { slackUserId: state },
    { accessToken: data.access_token, refreshToken: data.refresh_token },
    { upsert: true }
  );

  res.send(
    "✅ Your Google Calendar is now connected. You can go back to Slack!"
  );
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`⚡️ Server running on port ${PORT}`));
