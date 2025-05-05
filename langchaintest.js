// langchain-calendar-chat/index.js

import { ChatOpenAI } from "@langchain/openai";
import { initializeAgentExecutorWithOptions } from "langchain/agents";
import { DynamicTool } from "@langchain/core/tools";
import dotenv from "dotenv";
import { google } from "googleapis";
dotenv.config();

// Add Google Calendar client setup
const getCalendarClient = async (credentials) => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI2
  );

  // Set credentials (you'll need to handle token management)
  oauth2Client.setCredentials(credentials);

  return google.calendar({ version: "v3", auth: oauth2Client });
};

// Define tools
const tools = [
  new DynamicTool({
    name: "listCalendarEvents",
    description:
      "List calendar events or free slots for a specific day. You can filter by time or attendees.",
    func: async (input) => {
      const { date, type, beforeTime, afterTime } = JSON.parse(input);
      const calendar = await getCalendarClient(/* your stored credentials */);

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
      if (events.length === 0) {
        return "No events found for this day.";
      }

      return events
        .map(
          (event) =>
            `- ${event.summary} at ${new Date(
              event.start.dateTime
            ).toLocaleTimeString()}`
        )
        .join("\n");
    },
  }),

  new DynamicTool({
    name: "scheduleMeeting",
    description:
      "Schedule a new meeting given a title, date, time, and attendees.",
    func: async (input) => {
      const { title, date, startTime, endTime, attendees } = JSON.parse(input);
      const calendar = await getCalendarClient(/* your stored credentials */);

      const event = {
        summary: title,
        start: {
          dateTime: new Date(`${date} ${startTime}`).toISOString(),
        },
        end: {
          dateTime: new Date(`${date} ${endTime}`).toISOString(),
        },
        attendees: attendees?.map((email) => ({ email })),
      };

      const response = await calendar.events.insert({
        calendarId: "primary",
        resource: event,
        sendUpdates: "all",
      });

      return `Scheduled '${title}' on ${date} from ${startTime} to ${endTime} with ${
        attendees?.join(", ") || "no attendees"
      }.`;
    },
  }),

  new DynamicTool({
    name: "deleteMeeting",
    description: "Delete a meeting by title and date.",
    func: async (input) => {
      const { title, date } = JSON.parse(input);
      const calendar = await getCalendarClient(/* your stored credentials */);

      // First find the event
      const startTime = new Date(date);
      startTime.setHours(0, 0, 0);

      const endTime = new Date(date);
      endTime.setHours(23, 59, 59);

      const response = await calendar.events.list({
        calendarId: "primary",
        timeMin: startTime.toISOString(),
        timeMax: endTime.toISOString(),
        q: title,
      });

      const event = response.data.items.find((e) => e.summary === title);
      if (!event) {
        return `No meeting found with title '${title}' on ${date}.`;
      }

      await calendar.events.delete({
        calendarId: "primary",
        eventId: event.id,
        sendUpdates: "all",
      });

      return `Deleted meeting '${title}' on ${date}.`;
    },
  }),
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

// Example usage
const test = async () => {
  const reply = await runAgent(
    "Can you schedule a meeting with Jane tomorrow at 3pm?"
  );
  console.log("\n🤖 Agent reply:", reply);
};

test();
