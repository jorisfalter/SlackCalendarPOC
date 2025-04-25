const axios = require("axios");

const accessToken = ""; // ya.29 key
const event = {
  summary: "Meeting with Fred about the Q3 plan",
  start: {
    dateTime: "2025-04-25T12:00:00Z",
    timeZone: "Europe/Amsterdam",
  },
  end: {
    dateTime: "2025-04-25T12:30:00Z",
    timeZone: "Europe/Amsterdam",
  },
};

async function createCalendarEvent() {
  try {
    const res = await axios.post(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      event,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Event created:", res.data.htmlLink);
  } catch (err) {
    console.error(
      "❌ Failed to create event:",
      err.response?.data || err.message
    );
  }
}

createCalendarEvent();
