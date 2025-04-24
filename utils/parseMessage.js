// utils/parseMessage.js
// FOR ARCHIVE
const chrono = require("chrono-node");

function parseMessage(message) {
  const parsed = chrono.parse(message);
  if (!parsed.length) {
    return null; // couldn't parse any date
  }

  console.log(parsed);
  const { start, index, text } = parsed[0];
  const startTime = start.date();
  const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // default 1h

  // Try to get summary by removing the date portion
  let summary = message.replace(text, "").trim();
  if (!summary) summary = "Blocked time";

  return {
    start: startTime.toISOString(),
    end: endTime.toISOString(),
    summary,
  };
}

module.exports = parseMessage;
