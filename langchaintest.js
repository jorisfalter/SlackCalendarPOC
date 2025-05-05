// langchain-calendar-chat/index.js

import { ChatOpenAI } from "@langchain/openai";
import { initializeAgentExecutorWithOptions } from "langchain/agents";
import { DynamicTool } from "@langchain/core/tools";
import dotenv from "dotenv";
import { google } from "googleapis";
import axios from "axios";
dotenv.config();

const refreshAccessToken = async (refreshToken) => {
  try {
    const { data } = await axios.post(
      "https://oauth2.googleapis.com/token",
      null,
      {
        params: {
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        },
      }
    );
    return data.access_token;
  } catch (err) {
    console.error(
      "❌ Failed to refresh token:",
      err.response?.data || err.message
    );
    throw new Error("Unable to refresh Google access token");
  }
};

// Add Google Calendar client setup
const getCalendarClient = async () => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI2
  );

  try {
    const accessToken = await refreshAccessToken(
      process.env.GOOGLE_REFRESH_TOKEN
    );
    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });
  } catch (error) {
    console.error("Error refreshing access token:", error);
    throw new Error("Failed to refresh access token");
  }

  return google.calendar({ version: "v3", auth: oauth2Client });
};

// Define tools
const tools = [
  new DynamicTool({
    name: "listCalendarEvents",
    description:
      "List calendar events or free slots for a specific day. Input should be a date in YYYY-MM-DD format.",
    func: async (input) => {
      try {
        // Handle both string input and JSON object input
        let date;
        if (typeof input === "string") {
          try {
            const parsed = JSON.parse(input);
            date = parsed.input || parsed.date || input;
          } catch (e) {
            date = input;
          }
        } else {
          date = input.input || input.date || input;
        }

        console.log("Fetching calendar events for:", date); // Debug log

        const calendar = await getCalendarClient();

        const startTime = new Date(date);
        startTime.setHours(0, 0, 0);

        const endTime = new Date(date);
        endTime.setHours(23, 59, 59);

        const response = await calendar.events.list({
          calendarId: "primary",
          timeMin: startTime.toISOString(),
          timeMax: endTime.toISOString(),
          singleEvents: true,
          orderBy: "startTime",
        });

        const events = response.data.items;
        if (!events || events.length === 0) {
          return "No events found for this day.";
        }

        return events
          .map(
            (event) =>
              `- ${event.summary} at ${new Date(
                event.start.dateTime || event.start.date
              ).toLocaleTimeString()}`
          )
          .join("\n");
      } catch (error) {
        console.error("Error in listCalendarEvents:", error);
        if (error.message.includes("invalid_grant")) {
          return "Error: Calendar authentication failed. Please check your Google Calendar credentials.";
        }
        return `Error fetching calendar events: ${error.message}`;
      }
    },
  }),

  // new DynamicTool({
  //   name: "scheduleMeeting",
  //   description:
  //     "Schedule a new meeting given a title, date, time, and attendees.",
  //   func: async (input) => {
  //     const { title, date, startTime, endTime, attendees } = JSON.parse(input);
  //     const calendar = await getCalendarClient();

  //     const event = {
  //       summary: title,
  //       start: {
  //         dateTime: new Date(`${date} ${startTime}`).toISOString(),
  //       },
  //       end: {
  //         dateTime: new Date(`${date} ${endTime}`).toISOString(),
  //       },
  //       attendees: attendees?.map((email) => ({ email })),
  //     };

  //     const response = await calendar.events.insert({
  //       calendarId: "primary",
  //       resource: event,
  //       sendUpdates: "all",
  //     });

  //     return `Scheduled '${title}' on ${date} from ${startTime} to ${endTime} with ${
  //       attendees?.join(", ") || "no attendees"
  //     }.`;
  //   },
  // }),

  // new DynamicTool({
  //   name: "deleteMeeting",
  //   description: "Delete a meeting by title and date.",
  //   func: async (input) => {
  //     const { title, date } = JSON.parse(input);
  //     const calendar = await getCalendarClient();

  //     // First find the event
  //     const startTime = new Date(date);
  //     startTime.setHours(0, 0, 0);

  //     const endTime = new Date(date);
  //     endTime.setHours(23, 59, 59);

  //     const response = await calendar.events.list({
  //       calendarId: "primary",
  //       timeMin: startTime.toISOString(),
  //       timeMax: endTime.toISOString(),
  //       q: title,
  //     });

  //     const event = response.data.items.find((e) => e.summary === title);
  //     if (!event) {
  //       return `No meeting found with title '${title}' on ${date}.`;
  //     }

  //     await calendar.events.delete({
  //       calendarId: "primary",
  //       eventId: event.id,
  //       sendUpdates: "all",
  //     });

  //     return `Deleted meeting '${title}' on ${date}.`;
  //   },
  // }),
];

// Create chat model
const model = new ChatOpenAI({
  modelName: "gpt-4", // or gpt-3.5-turbo
  temperature: 0,
});

// Initialize agent
const executor = await initializeAgentExecutorWithOptions(tools, model, {
  agentType: "openai-functions",
  verbose: true,
});

// Main interaction function
export async function runAgent(message) {
  const result = await executor.call({ input: message });
  return result.output;
}

// Example usage with terminal input
const test = async () => {
  const { createInterface } = await import("readline/promises");
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const input = await rl.question("Enter your calendar request: ");
  // Add today's date to the input
  const today = new Date().toISOString().split("T")[0];
  const contextualInput = `Today is ${today}. ${input}`;

  const reply = await runAgent(contextualInput);
  console.log("\n🤖 Agent reply:", reply);
  rl.close();
};

const testCalendarAccess = async () => {
  try {
    const calendar = await getCalendarClient();
    const response = await calendar.events.list({
      calendarId: "primary",
      timeMin: new Date().toISOString(),
      maxResults: 1,
    });
    console.log("Calendar access successful:", response.data);
  } catch (error) {
    console.error("Calendar access failed:", error);
  }
};

// Add this line before the test() call
await testCalendarAccess();
test();
