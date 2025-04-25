require("dotenv").config();
const axios = require("axios");

async function testCalendarSearch(userInput) {
  try {
    // 1. Test OpenAI event extraction
    console.log("🔍 Testing with input:", userInput);

    const eventResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4",
        messages: [
          {
            role: "system",
            content: `Extract meeting details from the text. Today's date is ${
              new Date().toISOString().split("T")[0]
            }. Respond with a JSON object containing: title (the likely meeting title/topic), date (YYYY-MM-DD format, null if not specified), time (HH:mm format, null if not specified). Make educated guesses for the title based on context.`,
          },
          {
            role: "user",
            content: userInput,
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
    console.log("\n📅 Extracted Event Details:", eventDetails);

    // 2. Prepare time range
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

    console.log("\n⏰ Time Range:");
    console.log("TimeMin:", timeMin);
    console.log("TimeMax:", timeMax);

    // 3. Check if time is specified
    if (!timeMin || !timeMax) {
      console.log("\n⚠️  Error: Please specify both date and time");
      return;
    }

    // 4. Search Google Calendar
    // Note: You'll need a valid access token for this to work
    const accessToken = process.env.GOOGLE_ACCESS_TOKEN;

    const calendarResponse = await axios.get(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
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

    console.log("\n📊 Search Results:");
    if (events.length === 0) {
      console.log("❌ No matching events found");
    } else {
      console.log(`✅ Found ${events.length} matching events:`);
      events.forEach((event, index) => {
        console.log(`\nEvent ${index + 1}:`);
        console.log("Title:", event.summary);
        console.log("Start:", event.start.dateTime);
        console.log("End:", event.end.dateTime);
        console.log("ID:", event.id);
      });
    }
  } catch (error) {
    console.error("\n❌ Error:", error.response?.data || error.message);
  }
}

// Get input from command line arguments
const userInput =
  process.argv[2] ||
  "delete the meeting about project review on March 15th at 2pm";

// Run the test
testCalendarSearch(userInput);
