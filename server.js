const express = require("express");
// const bodyParser = require("body-parser");
const axios = require("axios");
const crypto = require("crypto");
const mongoose = require("mongoose");
require("dotenv").config();
// const parseMessage = require("./utils/parseMessage");
const app = express();
const rawBodySaver = function (req, res, buf) {
  if (buf && buf.length) {
    req.rawBody = buf.toString("utf8");
  }
};

app.use("/slack/events", express.raw({ type: "application/json" }));

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
  const slackSig = req.headers["x-slack-signature"];
  const sigBaseString = `v0:${timestamp}:${req.body.toString("utf8")}`;

  const mySig =
    "v0=" +
    crypto
      .createHmac("sha256", process.env.SLACK_SIGNING_SECRET)
      .update(sigBaseString)
      .digest("hex");

  return crypto.timingSafeEqual(Buffer.from(mySig), Buffer.from(slackSig));
}

// refresh access token
async function refreshAccessToken(user) {
  try {
    const { data } = await axios.post(
      "https://oauth2.googleapis.com/token",
      null,
      {
        params: {
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          refresh_token: user.refreshToken,
          grant_type: "refresh_token",
        },
      }
    );

    // Update the user's token in the database
    user.accessToken = data.access_token;
    await user.save();

    return data.access_token;
  } catch (err) {
    console.error(
      "❌ Failed to refresh token:",
      err.response?.data || err.message
    );
    throw new Error("Unable to refresh Google access token");
  }
}

// Slack event handler
app.post("/slack/events", async (req, res) => {
  console.log("🔔 Slack /slack/events route hit");

  // Step 2.1: Verify signature using raw body
  if (!verifySlackRequest(req)) {
    console.error("❌ Invalid Slack signature received");
    return res.status(400).send("Invalid signature");
  }

  // Step 2.2: Parse the raw body manually now that it's verified
  let body;
  try {
    body = JSON.parse(req.body.toString("utf8"));
  } catch (err) {
    console.error("❌ Failed to parse Slack request body:", err);
    return res.status(400).send("Invalid body");
  }

  const { type, challenge, event } = body;
  if (req.headers["x-slack-retry-num"]) {
    console.log("⏩ Slack retry, skipping");
    return res.sendStatus(200);
  }
  if (type === "url_verification") return res.send(challenge);

  try {
    if (event && event.type === "message" && !event.bot_id) {
      const slackUserId = event.user;
      const channel = event.channel;

      const user = await User.findOne({ slackUserId });
      console.log("💬 DM received:", event.text, "from user:", slackUserId);

      if (!user) {
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${process.env.GOOGLE_REDIRECT_URI}&response_type=code&scope=https://www.googleapis.com/auth/calendar.events&access_type=offline&prompt=consent&state=${slackUserId}`;
        await axios.post(
          "https://slack.com/api/chat.postMessage",
          {
            channel: event.channel,
            text: `Please connect your Google Calendar: <${authUrl}|Click here to connect>`,
          },
          {
            headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
          }
        );
        return res.sendStatus(200);
      }

      // Refresh the access token before making the webhook call
      const newAccessToken = await refreshAccessToken(user);

      // Check message intent using OpenAI
      try {
        const openaiResponse = await axios.post(
          "https://api.openai.com/v1/chat/completions",
          {
            model: "gpt-3.5-turbo",
            messages: [
              {
                role: "system",
                content:
                  "You are a helper that categorizes calendar-related requests. Respond with exactly 'create' for requests to create/add meetings, or 'delete' for requests to delete/remove meetings.",
              },
              {
                role: "user",
                content: event.text,
              },
            ],
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
          }
        );

        const intent = openaiResponse.data.choices[0].message.content
          .trim()
          .toLowerCase();

        console.log("💬 Intent:", intent);
        if (intent === "create") {
          // send to make.com
          try {
            await axios.post(
              "https://hook.eu2.make.com/quvocngj7dt2m8dcefft1w6alf6lqwt7",
              {
                message: event.text,
                userId: slackUserId,
                token: newAccessToken,
              }
            );
          } catch (error) {
            console.error("❌ Failed to send request to Make.com webhook:", {
              message: error.message,
              response: error.response?.data,
              status: error.response?.status,
              userId: slackUserId,
              originalMessage: event.text,
            });

            await axios.post(
              "https://slack.com/api/chat.postMessage",
              {
                channel: event.channel,
                text: `❌ Sorry, I couldn't process your request: ${error.message}`,
              },
              {
                headers: {
                  Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
                },
              }
            );
            return res.sendStatus(200);
          }
        } else if (intent === "delete") {
          console.log("🗑️ Delete meeting request detected:", event.text);

          // Get event details from OpenAI
          const eventResponse = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
              model: "gpt-4o",
              messages: [
                {
                  role: "system",
                  content: `Extract meeting details from the text. Today's date is ${
                    new Date().toISOString().split("T")[0]
                  }. Respond with a JSON object containing: title (the likely meeting title/topic), date (YYYY-MM-DD format, null if not specified), time (HH:mm format, null if not specified). Make educated guesses for the title based on context.`,
                },
                {
                  role: "user",
                  content: event.text,
                },
              ],
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                "Content-Type": "application/json",
              },
            }
          );

          const eventDetails = JSON.parse(
            eventResponse.data.choices[0].message.content
          );
          console.log("💬 Event Details:", eventDetails);

          try {
            // Search for events in user's calendar
            const timeMin =
              eventDetails.date && eventDetails.time
                ? new Date(
                    `${eventDetails.date}T${eventDetails.time}:00Z`
                  ).toISOString()
                : null;
            const timeMax =
              eventDetails.date && eventDetails.time
                ? new Date(
                    `${eventDetails.date}T${eventDetails.time}:59Z`
                  ).toISOString()
                : null;

            console.log("💬 TimeMin:", timeMin);
            console.log("💬 TimeMax:", timeMax);

            // If no specific time was provided, ask for more details
            if (!timeMin || !timeMax) {
              await axios.post(
                "https://slack.com/api/chat.postMessage",
                {
                  channel: event.channel,
                  text: "⚠️ Please specify both the date and time of the meeting you want to delete. For example: 'delete the meeting about project review on March 15th at 2pm'",
                },
                {
                  headers: {
                    Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
                  },
                }
              );
              return res.sendStatus(200);
            }

            const calendarResponse = await axios.get(
              "https://www.googleapis.com/calendar/v3/calendars/primary/events",
              {
                headers: { Authorization: `Bearer ${newAccessToken}` },
                params: {
                  q: eventDetails.title,
                  timeMin,
                  timeMax,
                  singleEvents: true,
                  orderBy: "startTime",
                },
              }
            );

            const events = calendarResponse.data.items;

            if (events.length === 0) {
              await axios.post(
                "https://slack.com/api/chat.postMessage",
                {
                  channel: event.channel,
                  text: "❌ I couldn't find any matching events in your calendar. Please try being more specific about which meeting you want to delete.",
                },
                {
                  headers: {
                    Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
                  },
                }
              );
              return res.sendStatus(200);
            }

            // Delete the first matching event
            await axios.delete(
              `https://www.googleapis.com/calendar/v3/calendars/primary/events/${events[0].id}`,
              {
                headers: { Authorization: `Bearer ${newAccessToken}` },
              }
            );

            await axios.post(
              "https://slack.com/api/chat.postMessage",
              {
                channel: event.channel,
                text: `✅ I've deleted the meeting "${
                  events[0].summary
                }" scheduled for ${new Date(
                  events[0].start.dateTime || events[0].start.date
                ).toLocaleString()}.`,
              },
              {
                headers: {
                  Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
                },
              }
            );
          } catch (error) {
            console.error("❌ Error deleting calendar event:", error);
            await axios.post(
              "https://slack.com/api/chat.postMessage",
              {
                channel: event.channel,
                text: "❌ Sorry, I encountered an error while trying to delete the event. Please try again.",
              },
              {
                headers: {
                  Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
                },
              }
            );
          }
        }
      } catch (error) {
        console.error("❌ Error checking message intent with OpenAI:", error);
        // Continue with original error handling
      }

      await axios.post(
        "https://slack.com/api/chat.postMessage",
        {
          channel: event.channel,
          text: `Thank you, I have received your request, I'm working on it, I don't have a feedback loop yet, so please confirm by checking your calendar`,
        },
        {
          headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        }
      );
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error in Slack event handler:", error);
    return res.status(500).send("Internal server error");
  }
});

// OAuth redirect handler
app.get("/google/oauth/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      console.error("Missing OAuth parameters:", { code, state });
      return res.status(400).send("Missing required OAuth parameters");
    }

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
  } catch (error) {
    console.error("Error in Google OAuth callback:", error);
    res
      .status(500)
      .send("Failed to connect Google Calendar. Please try again.");
  }
});

app.post("/slack/slash", async (req, res) => {
  try {
    console.log("Slash command received:", req.body);

    // Respond to Slack immediately
    res.json({
      response_type: "ephemeral",
      text: "🕐 Blocking your time... (not yet implemented)",
    });

    // You could trigger background logic here if needed
  } catch (err) {
    console.error("Error in /slack/slash:", err);
    res.status(500).send("Something went wrong");
  }
});

app.get("/", (req, res) => {
  console.log("Ping received on /");
  res.send("Bot is running");
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`⚡️ Server running on port ${PORT}`));
