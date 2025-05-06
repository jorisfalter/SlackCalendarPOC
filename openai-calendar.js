import dotenv from "dotenv";
import { google } from "googleapis";
import axios from "axios";
import OpenAI from "openai";
import express from "express";
dotenv.config();

// Add these time range constants at the top of the file
const TIME_RANGES = {
  morning: { start: 6, end: 12 }, // 6:00 AM - 12:00 PM
  afternoon: { start: 12, end: 18 }, // 12:00 PM - 6:00 PM
  evening: { start: 18, end: 23 }, // 6:00 PM - 11:00 PM
};

// Helper functions for week calculations
function getStartOfWeek(date) {
  const timeZone = "Europe/Amsterdam";
  const start = new Date(date);

  // Get to Monday (1) from whatever day we're on
  while (start.getDay() !== 1) {
    start.setDate(start.getDate() - 1);
  }

  // Set to start of day in Amsterdam time
  start.setHours(0, 0, 0, 0);

  // Convert to UTC for API
  const offset = -2; // Amsterdam is UTC+2
  start.setHours(start.getHours() - offset);

  return start;
}

function getEndOfWeek(date) {
  console.log("getEndOfWeek called with date:", date);
  const timeZone = "Europe/Amsterdam";
  const end = new Date(date);

  // First get to Sunday
  while (end.getDay() !== 0) {
    end.setDate(end.getDate() + 1);
    console.log("Moving to next day:", end.toISOString(), "Day:", end.getDay());
  }

  // Set to end of day in Amsterdam time
  end.setHours(23, 59, 59, 999);
  console.log("After setting hours:", end.toISOString());

  // Convert to UTC for API
  const offset = -2; // Amsterdam is UTC+2
  end.setHours(end.getHours() - offset);
  console.log("After timezone adjustment:", end.toISOString());

  return end;
}

// Token refresh and calendar client setup (keeping these from the original)
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

// Add these helper functions at the top
function getRelativeDate(dayName) {
  const days = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };

  const today = new Date();
  const targetDay = days[dayName.toLowerCase()];
  const currentDay = today.getDay();
  let daysToAdd = targetDay - currentDay;
  if (daysToAdd <= 0) daysToAdd += 7;

  const result = new Date(today);
  result.setDate(today.getDate() + daysToAdd);
  return result;
}

// Simplify date parsing
function parseDate(dateStr) {
  if (!dateStr) return new Date();
  const lowerDate = (dateStr || "").toLowerCase();

  const today = new Date();
  if (lowerDate.includes("today")) return today;
  if (lowerDate.includes("tomorrow")) {
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    return tomorrow;
  }

  const dayMatches = lowerDate.match(
    /(?:this\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i
  );
  if (dayMatches) return getRelativeDate(dayMatches[1]);

  return new Date(dateStr);
}

// Add this helper function to check for overlapping meetings
function findOverlappingMeetings(events) {
  const overlaps = new Set();

  for (let i = 0; i < events.length; i++) {
    const event1Start = new Date(
      events[i].start.dateTime || events[i].start.date
    );
    const event1End = new Date(events[i].end.dateTime || events[i].end.date);

    for (let j = i + 1; j < events.length; j++) {
      const event2Start = new Date(
        events[j].start.dateTime || events[j].start.date
      );
      const event2End = new Date(events[j].end.dateTime || events[j].end.date);

      if (event1Start < event2End && event2Start < event1End) {
        overlaps.add(events[i].id);
        overlaps.add(events[j].id);
      }
    }
  }

  return overlaps;
}

// Update getEvents function
async function getEvents({ start_date, end_date, attendee, keyword }) {
  try {
    const calendar = await getCalendarClient();
    const timeZone = "Europe/Amsterdam";
    let timeMin, timeMax;

    console.log("Keyword received:", keyword);

    // Extract "this week" from keyword if present
    const isThisWeek = keyword && /this\s*we+k/i.test(keyword);
    // Extract topic keywords, removing "this week" if present
    const topicKeyword = keyword
      ?.toLowerCase()
      .replace(/this\s*we+k/i, "")
      .trim();

    // If looking for meetings "this week", set appropriate range
    if (isThisWeek) {
      console.log("Detected 'this week' request");
      timeMin = getStartOfWeek(new Date());
      timeMax = getEndOfWeek(new Date());

      console.log("Week range calculation:", {
        start: timeMin.toISOString(),
        end: timeMax.toISOString(),
        startDay: timeMin.getDay(),
        endDay: timeMax.getDay(),
      });
    } else {
      console.log("Not a 'this week' request");
      const timeOfDay = keyword
        ?.toLowerCase()
        .match(/morning|afternoon|evening/)?.[0];

      // Extract date from keyword if not explicitly provided
      if (!start_date && keyword) {
        const dayMatch = keyword
          .toLowerCase()
          .match(
            /(?:this\s+)?(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i
          );
        if (dayMatch) {
          start_date = dayMatch[0];
        }
      }

      timeMin = parseDate(start_date);
      timeMax = new Date(timeMin); // Initialize timeMax with timeMin

      // Set hours based on time of day or start of day
      if (keyword?.toLowerCase().includes("morning")) {
        timeMin.setHours(0, 0, 0, 0);
        timeMax.setHours(12, 0, 0, 0); // End at noon
      } else if (timeOfDay && TIME_RANGES[timeOfDay]) {
        timeMin.setHours(TIME_RANGES[timeOfDay].start, 0, 0, 0);
        timeMax.setHours(TIME_RANGES[timeOfDay].end, 0, 0, 0);
      } else {
        timeMin.setHours(0, 0, 0, 0);
        timeMax.setHours(23, 59, 59, 999);
      }
    }

    const response = await calendar.events.list({
      calendarId: "primary",
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      timeZone: timeZone,
      maxResults: 2500, // Increase this to get more events
    });

    console.log("Week range:", {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      events: response.data.items.map((e) => ({
        summary: e.summary,
        start: e.start.dateTime || e.start.date,
        recurring: !!e.recurringEventId,
      })),
    });

    let events = response.data.items;

    // Filter by topic if provided
    if (topicKeyword && !/morning|afternoon|evening/i.test(topicKeyword)) {
      console.log("Filtering by topic:", topicKeyword);
      events = events.filter((event) =>
        event.summary.toLowerCase().includes(topicKeyword)
      );
    }

    // Additional time-of-day filtering
    if (keyword && keyword.match(/morning|afternoon|evening/)) {
      events = events.filter((event) => {
        const eventTime = new Date(event.start.dateTime || event.start.date);
        const hour = eventTime.getHours();
        return (
          hour >=
            TIME_RANGES[keyword.toLowerCase().replace(/[^a-z]/g, "")].start &&
          hour < TIME_RANGES[keyword.toLowerCase().replace(/[^a-z]/g, "")].end
        );
      });
    }

    // Filter by attendee if specified
    if (attendee) {
      console.log("Filtering by attendee:", attendee); // Debug log
      events = events.filter((event) => {
        // Check if event has attendees
        if (!event.attendees) {
          return false;
        }

        return event.attendees.some((a) => {
          const attendeeName = (a.displayName || a.email || "").toLowerCase();
          const searchName = attendee.toLowerCase();
          console.log(`Comparing ${attendeeName} with ${searchName}`); // Debug log
          return attendeeName.includes(searchName);
        });
      });
    }

    if (!events || events.length === 0) {
      return "No events found for the specified criteria.";
    }

    // Group events by date
    const eventsByDate = events.reduce((acc, event) => {
      const date = new Date(
        event.start.dateTime || event.start.date
      ).toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "Europe/Amsterdam",
      });
      if (!acc[date]) acc[date] = [];
      acc[date].push(event);
      return acc;
    }, {});

    // Format output with dates
    return Object.entries(eventsByDate)
      .sort(([dateA], [dateB]) => new Date(dateA) - new Date(dateB))
      .map(([date, dayEvents]) => {
        // Remove duplicates by event ID
        const uniqueEvents = dayEvents.filter(
          (event, index, self) =>
            index === self.findIndex((e) => e.id === event.id)
        );

        // Only check for overlaps if explicitly asked
        const overlappingEvents = keyword?.toLowerCase().includes("overlap")
          ? findOverlappingMeetings(uniqueEvents)
          : new Set();

        // Add warning only if explicitly asked about overlaps
        let output = "";
        if (
          keyword?.toLowerCase().includes("overlap") &&
          overlappingEvents.size > 0
        ) {
          output += "Found overlapping meetings\n\n";
        }

        const eventsStr = uniqueEvents
          .sort((a, b) => {
            const timeA = new Date(a.start.dateTime || a.start.date);
            const timeB = new Date(b.start.dateTime || b.start.date);
            return timeA - timeB;
          })
          .map((event) => {
            const eventTime = new Date(
              event.start.dateTime || event.start.date
            );
            const isOverlapping = overlappingEvents.has(event.id);
            return `  - ${
              isOverlapping && keyword?.toLowerCase().includes("overlap")
                ? "⚠️ "
                : ""
            }${event.summary} at ${eventTime.toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: true,
              timeZone: "Europe/Amsterdam",
            })}`;
          })
          .join("\n");
        return `${date}:\n${output}${eventsStr}`;
      })
      .join("\n\n");
  } catch (error) {
    console.error("Error fetching events:", error);
    throw error;
  }
}

// OpenAI function definition
const functions = [
  {
    name: "get_events",
    description:
      "Get calendar events based on filters like dates or attendees.",
    parameters: {
      type: "object",
      properties: {
        start_date: {
          type: "string",
          description:
            "Start date - use relative terms like 'today', 'tomorrow', 'friday', 'next monday' instead of ISO dates",
        },
        end_date: {
          type: "string",
          description:
            "End date - use relative terms like 'today', 'tomorrow', 'friday', 'next monday' instead of ISO dates",
        },
        attendee: {
          type: "string",
          description: "Name or email of the person in the meeting",
        },
        keyword: {
          type: "string",
          description:
            "Keyword to filter meetings. Use 'this week' to get all meetings this week, or 'morning/afternoon/evening' for time of day",
        },
      },
      required: [],
    },
  },
  {
    name: "get_meeting_details",
    description: "Get detailed information about a specific meeting.",
    parameters: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "Date of the meeting in ISO format (YYYY-MM-DD)",
        },
        summary: {
          type: "string",
          description: "Title/summary of the meeting to find",
        },
        time: {
          type: "string",
          description: "Approximate time of the meeting (HH:MM)",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "create_meeting",
    description:
      "Create a new calendar event/meeting. Must confirm duration before creating.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Title/topic of the meeting (required)",
        },
        date: {
          type: "string",
          description:
            "Date of the meeting in ISO format (YYYY-MM-DD) (required)",
        },
        start_time: {
          type: "string",
          description: "Start time in HH:MM format (24-hour) (required)",
        },
        end_time: {
          type: "string",
          description:
            "End time in HH:MM format (24-hour) (required - must be confirmed with user)",
        },
        recurrence: {
          type: "string",
          description:
            "Day of the week for recurring meetings (e.g., 'Thursday' for weekly on Thursdays)",
        },
        description: {
          type: "string",
          description: "Optional meeting description or agenda",
        },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of attendee email addresses",
        },
        location: {
          type: "string",
          description: "Optional meeting location or video conference link",
        },
      },
      required: ["summary", "date", "start_time", "end_time"],
    },
  },
  {
    name: "modify_meeting",
    description: "Modify an existing calendar event/meeting.",
    parameters: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description:
            "Current date of the meeting - can use relative terms like 'today', 'tomorrow', 'friday'",
        },
        summary: {
          type: "string",
          description: "Current title/summary of the meeting to find",
        },
        time: {
          type: "string",
          description: "Approximate current time of the meeting (HH:MM)",
        },
        updates: {
          type: "object",
          description: "New values to update the meeting with",
          properties: {
            summary: {
              type: "string",
              description: "New title for the meeting",
            },
            date: {
              type: "string",
              description:
                "New date for the meeting - can use relative terms like 'today', 'tomorrow', 'friday'",
            },
            start_time: {
              type: "string",
              description: "New start time in HH:MM format (24-hour)",
            },
            end_time: {
              type: "string",
              description: "New end time in HH:MM format (24-hour)",
            },
            description: {
              type: "string",
              description: "New meeting description",
            },
            location: {
              type: "string",
              description: "New meeting location",
            },
          },
        },
      },
      required: ["date"],
    },
  },
];

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Add this at the top level of the file
let conversationHistory = [];

// Add at the top of the file
const processedMessages = new Set();

// Main interaction function
async function processCalendarRequest(userInput) {
  try {
    const today = new Date().toISOString().split("T")[0];

    // Add user's new message to history
    conversationHistory.push({ role: "user", content: userInput });

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `You are a calendar assistant that helps manage meetings.
- For calendar queries:
  - When user asks about meetings with a topic (e.g. "marketing meetings"), include the topic in the keyword
  - When user asks about "this week", include "this week" in the keyword
  - For "meetings about X this week", pass both the topic and "this week" in the keyword
  - Examples:
    - "do i have any meetings about marketing this week" -> keyword="marketing this week"
    - "what marketing meetings do i have" -> keyword="marketing"
    - "what meetings do i have this week" -> keyword="this week"
- For new meetings:
  - Ask for duration if not specified
  - Accept user's preferred time if given
  - When scheduling relative to other meetings:
    - First find the referenced meeting
    - Then schedule around it appropriately
  - When attendees are mentioned:
    - Ask for their email address if not provided
    - Format: "Could you provide Frank's email address to send the invitation?"
- Keep responses clear and concise
- Don't question user's choices once they're clear
- Don't suggest changes to confirmed times/durations`,
        },
        {
          role: "system",
          content: `Today's date is ${today}.`,
        },
        ...conversationHistory,
      ],
      functions,
      function_call: "auto",
    });

    const message = completion.choices[0].message;
    let response;

    if (message.function_call) {
      const args = JSON.parse(message.function_call.arguments);
      if (message.function_call.name === "get_events") {
        response = await getEvents(args);
      } else if (message.function_call.name === "get_meeting_details") {
        response = await getMeetingDetails(args);
      } else if (message.function_call.name === "create_meeting") {
        response = await createMeeting(args);
      } else if (message.function_call.name === "modify_meeting") {
        response = await modifyMeeting(args);
      }
    } else {
      // If no function was called, use the assistant's response to ask for more details
      response = message.content;
    }

    // Add assistant's response to history
    conversationHistory.push({
      role: "assistant",
      content: response,
      function_call: message.function_call,
    });

    return response;
  } catch (error) {
    console.error("Error processing request:", error);
    return `Error: ${error.message}`;
  }
}

// Modify the test function to handle multiple interactions
const test = async () => {
  const { createInterface } = await import("readline/promises");
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  while (true) {
    const input = await rl.question(
      "\nEnter your calendar request (or 'exit' to quit): "
    );

    if (input.toLowerCase() === "exit") {
      console.log("Goodbye! 👋");
      rl.close();
      break;
    }

    const reply = await processCalendarRequest(input);
    console.log("\n🤖 Reply:", reply);
  }
};

// Test calendar access before starting
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

// Add this new function to fetch meeting details
async function getMeetingDetails({ date, summary, time }) {
  try {
    const calendar = await getCalendarClient();

    const startTime = new Date(date);
    startTime.setHours(0, 0, 0);
    const endTime = new Date(date);
    endTime.setHours(23, 59, 59);

    const response = await calendar.events.list({
      calendarId: "primary",
      timeMin: startTime.toISOString(),
      timeMax: endTime.toISOString(),
      singleEvents: false,
    });

    let events = response.data.items;

    // Filter by summary if provided
    if (summary) {
      events = events.filter((event) =>
        event.summary.toLowerCase().includes(summary.toLowerCase())
      );
    }

    // Filter by approximate time if provided
    if (time) {
      const [targetHour, targetMinute] = time.split(":").map(Number);
      events = events.filter((event) => {
        const eventTime = new Date(event.start.dateTime || event.start.date);
        const hourDiff = Math.abs(eventTime.getHours() - targetHour);
        return hourDiff <= 1;
      });
    }

    if (!events.length) {
      return "No matching meeting found.";
    }

    const event = events[0];

    // Calculate duration
    const startDateTime = new Date(event.start.dateTime || event.start.date);
    const endDateTime = new Date(event.end.dateTime || event.end.date);
    const durationMinutes = Math.round(
      (endDateTime - startDateTime) / (1000 * 60)
    );
    const durationText =
      durationMinutes >= 60
        ? `${Math.floor(durationMinutes / 60)} hour${
            Math.floor(durationMinutes / 60) !== 1 ? "s" : ""
          }${
            durationMinutes % 60 ? ` and ${durationMinutes % 60} minutes` : ""
          }`
        : `${durationMinutes} minutes`;

    // Parse recurrence rule if it exists
    let recurrenceInfo = "";
    if (event.recurrence) {
      const rrule = event.recurrence[0];
      if (rrule.includes("FREQ=WEEKLY")) {
        const day = rrule.match(/BYDAY=([A-Z]{2})/)?.[1];
        const dayMap = {
          MO: "Mondays",
          TU: "Tuesdays",
          WE: "Wednesdays",
          TH: "Thursdays",
          FR: "Fridays",
          SA: "Saturdays",
          SU: "Sundays",
        };
        recurrenceInfo = `Repeats weekly on ${dayMap[day] || day}`;
      }
    }

    return `
Meeting: ${event.summary}
Time: ${startDateTime.toLocaleString()} (${durationText})
${
  event.description
    ? `Description: ${event.description}`
    : "No description available"
}
${event.location ? `Location: ${event.location}` : ""}
${
  event.attendees
    ? `Attendees: ${event.attendees.map((a) => a.email).join(", ")}`
    : ""
}
${recurrenceInfo ? `Recurrence: ${recurrenceInfo}` : "One-time meeting"}
    `.trim();
  } catch (error) {
    console.error("Error fetching meeting details:", error);
    throw error;
  }
}

// Add this helper function at the top level
function generateRecurrenceRule(frequency = "WEEKLY", day) {
  // Ensure day is in correct format (MO, TU, WE, TH, FR, SA, SU)
  const dayMap = {
    monday: "MO",
    tuesday: "TU",
    wednesday: "WE",
    thursday: "TH",
    friday: "FR",
    saturday: "SA",
    sunday: "SU",
  };

  const formattedDay = dayMap[day.toLowerCase()];
  if (!formattedDay) {
    throw new Error(`Invalid day: ${day}`);
  }

  return `RRULE:FREQ=${frequency};BYDAY=${formattedDay}`;
}

// Update the createMeeting function
async function createMeeting({
  summary,
  date,
  start_time,
  end_time,
  description,
  attendees,
  location,
  recurrence,
}) {
  try {
    const calendar = await getCalendarClient();
    const timeZone = "Europe/Amsterdam";

    // Parse the date in Amsterdam timezone
    const [year, month, day] = date.split("-").map(Number);
    const [startHour, startMinute] = start_time.split(":").map(Number);

    // Create date in Amsterdam timezone
    const startDateTime = new Date(
      Date.UTC(
        year,
        month - 1, // JavaScript months are 0-based
        day,
        startHour - 2, // Convert to UTC (Amsterdam is UTC+2)
        startMinute
      )
    );

    // Handle end time similarly
    const endDateTime = new Date(
      Date.UTC(
        year,
        month - 1,
        day,
        end_time ? parseInt(end_time.split(":")[0]) - 2 : startHour - 1,
        end_time ? parseInt(end_time.split(":")[1]) : startMinute
      )
    );

    const event = {
      summary,
      description,
      location,
      start: {
        dateTime: startDateTime.toISOString(),
        timeZone: timeZone,
      },
      end: {
        dateTime: endDateTime.toISOString(),
        timeZone: timeZone,
      },
      // Add recurrence if specified
      recurrence: recurrence
        ? [generateRecurrenceRule("WEEKLY", recurrence)]
        : undefined,
      // Only include attendees if they're actual email addresses
      attendees: attendees
        ?.filter((a) => a.includes("@"))
        .map((email) => ({ email })),
    };

    const response = await calendar.events.insert({
      calendarId: "primary",
      requestBody: event,
      sendUpdates: "all",
    });

    const recurrenceText = recurrence ? " (Recurring)" : "";
    return `
Meeting created successfully${recurrenceText}:
- ${summary}
- ${startDateTime.toLocaleString()} to ${endDateTime.toLocaleString()}
${description ? `- Description: ${description}` : ""}
${location ? `- Location: ${location}` : ""}
${attendees ? `- With: ${attendees.join(", ")}` : ""}
${recurrence ? `- Repeats: Weekly on ${recurrence}s` : ""}
    `.trim();
  } catch (error) {
    console.error("Error creating meeting:", error);
    throw error;
  }
}

// Update the modifyMeeting function
async function modifyMeeting({ date, summary, time, updates }) {
  try {
    const calendar = await getCalendarClient();

    // Use the same date parsing logic as getEvents
    function parseDate(dateStr) {
      if (!dateStr) return new Date();

      const lowerDate = (dateStr || "").toLowerCase();
      console.log("Parsing date for modification:", lowerDate);

      // Handle relative day references
      const today = new Date();
      if (lowerDate.includes("today")) return today;
      if (lowerDate.includes("tomorrow")) {
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);
        return tomorrow;
      }

      // Handle day names (this week)
      const dayMatches = lowerDate.match(
        /(?:this\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i
      );
      if (dayMatches) {
        return getRelativeDate(dayMatches[1]);
      }

      // Handle ISO dates
      return new Date(dateStr);
    }

    // Parse the target date
    const targetDate = parseDate(date);
    console.log("Target date for modification:", targetDate);

    // If updates contain a day name, update the date
    if (updates.date) {
      const newDate = parseDate(updates.date);
      console.log("New date from updates:", newDate);
      // Update the event date while keeping the same time
      const eventDateTime = new Date(event.start.dateTime || event.start.date);
      eventDateTime.setFullYear(newDate.getFullYear());
      eventDateTime.setMonth(newDate.getMonth());
      eventDateTime.setDate(newDate.getDate());
      updatedEvent.start = {
        dateTime: eventDateTime.toISOString(),
        timeZone: event.start.timeZone,
      };
      // Maintain the same duration
      const newEnd = new Date(eventDateTime.getTime() + eventDuration);
      updatedEvent.end = {
        dateTime: newEnd.toISOString(),
        timeZone: event.end.timeZone,
      };
    }

    // First find the meeting
    const startTime = new Date(targetDate);
    startTime.setHours(0, 0, 0);
    const endTime = new Date(targetDate);
    endTime.setHours(23, 59, 59);

    const response = await calendar.events.list({
      calendarId: "primary",
      timeMin: startTime.toISOString(),
      timeMax: endTime.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    let events = response.data.items;

    // Filter by summary if provided
    if (summary) {
      events = events.filter((event) =>
        event.summary.toLowerCase().includes(summary.toLowerCase())
      );
    }

    // Filter by approximate time if provided
    if (time) {
      const [targetHour, targetMinute] = time.split(":").map(Number);
      events = events.filter((event) => {
        const eventTime = new Date(event.start.dateTime || event.start.date);
        const hourDiff = Math.abs(eventTime.getHours() - targetHour);
        const minuteDiff = Math.abs(eventTime.getMinutes() - targetMinute);
        return hourDiff === 0 && minuteDiff < 30; // More precise time matching
      });
    }

    if (!events.length) {
      return "No matching meeting found to modify.";
    }

    const event = events[0];
    const eventDateTime = new Date(event.start.dateTime || event.start.date);
    const originalStart = new Date(event.start.dateTime);
    const originalEnd = new Date(event.end.dateTime);
    const eventDuration = originalEnd.getTime() - originalStart.getTime();

    // Prepare the update
    const updatedEvent = {
      ...event,
      summary: updates.summary || event.summary,
      description: updates.description || event.description,
      location: updates.location || event.location,
    };

    // Update times if provided
    if (updates.start_time) {
      const [startHour, startMinute] = updates.start_time
        .split(":")
        .map(Number);
      const newStart = new Date(eventDateTime);
      newStart.setHours(startHour, startMinute, 0, 0); // Added milliseconds
      updatedEvent.start = {
        dateTime: newStart.toISOString(),
        timeZone: event.start.timeZone,
      };

      // Maintain the same duration when changing start time
      const newEnd = new Date(newStart.getTime() + eventDuration);
      updatedEvent.end = {
        dateTime: newEnd.toISOString(),
        timeZone: event.end.timeZone,
      };
    }

    if (updates.end_time) {
      const [endHour, endMinute] = updates.end_time.split(":").map(Number);
      const newEnd = new Date(eventDateTime);
      newEnd.setHours(endHour, endMinute, 0);
      updatedEvent.end = {
        dateTime: newEnd.toISOString(),
        timeZone: event.end.timeZone,
      };
    }

    // Perform the update
    const updateResponse = await calendar.events.update({
      calendarId: "primary",
      eventId: event.id,
      requestBody: updatedEvent,
      sendUpdates: "all",
    });

    return `
Meeting rescheduled successfully:
- ${updatedEvent.summary}
- From: ${originalStart.toLocaleString()} - ${originalEnd.toLocaleString()}
- To: ${new Date(updatedEvent.start.dateTime).toLocaleString()} - ${new Date(
      updatedEvent.end.dateTime
    ).toLocaleString()}
${updatedEvent.description ? `- Description: ${updatedEvent.description}` : ""}
${updatedEvent.location ? `- Location: ${updatedEvent.location}` : ""}
    `.trim();
  } catch (error) {
    console.error("Error modifying meeting:", error);
    throw error;
  }
}

// Create Express server
const app = express();
app.use(express.json());

// Handle Slack messages
app.post("/slack/events", async (req, res) => {
  // Log the entire request body for debugging
  console.log("Received Slack request:", req.body);

  // Handle URL verification
  if (req.body.type === "url_verification") {
    console.log("Verification challenge received:", req.body.challenge);
    return res.json({
      challenge: req.body.challenge,
    });
  }

  // Get the event
  const { event } = req.body;

  // Check if we've already processed this message
  if (processedMessages.has(event.ts)) {
    console.log("Duplicate message, ignoring:", event.ts);
    return res.sendStatus(200);
  }
  processedMessages.add(event.ts);

  try {
    console.log("Received message:", event.text);
    console.log("From user:", event.user);

    // Only respond to messages from the specified user
    if (event.user !== process.env.SLACK_USER_ID) {
      console.log(`Ignoring message from user ${event.user}`);
      return res.sendStatus(200);
    }

    // Process the calendar request
    const response = await processCalendarRequest(event.text);

    // Send the response back to Slack as a DM
    await axios.post(
      "https://slack.com/api/chat.postMessage",
      {
        channel: event.user, // Send to user's DM instead of the channel
        text: response,
        // Remove thread_ts to avoid threading
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN2}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.sendStatus(200);
  } catch (error) {
    console.error("Error handling Slack message:", error);
    res.sendStatus(500);
  }
});

// Simple health check
app.get("/health", (req, res) => {
  res.send("OK");
});

// Change the startup logic
if (process.argv[2] === "--cli") {
  // Start CLI interface
  (async () => {
    await testCalendarAccess();
    await test();
  })();
} else {
  // Start Slack server (default)
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`🚀 Server is running on port ${port}`);
    console.log(`✅ Listening for user: ${process.env.SLACK_USER_ID}`);
  });
}
