import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  slackUserId: {
    type: String,
    required: true,
    unique: true,
  },
  accessToken: {
    type: String,
    required: true,
  },
  refreshToken: {
    type: String,
    required: true,
  },
  timezone: {
    type: String,
    default: "Europe/Amsterdam", // Default fallback
  },
  lastInteraction: {
    type: Date,
    default: Date.now,
  },
});

const User = mongoose.model("User", userSchema);

export default User;
