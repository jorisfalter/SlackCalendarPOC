require("dotenv").config();
const axios = require("axios");

// Function to generate Google OAuth URL
async function generateGoogleAuthUrl() {
  // Send message to Slack
  await axios.post(
    "https://slack.com/api/chat.postMessage",
    {
      channel: "", // You'll need to specify the channel ID
      text: "blabla",
    },
    {
      headers: {
        Authorization: `Bearer xoxb-`,
      },
    }
  );

  return "ok";
}

generateGoogleAuthUrl();
