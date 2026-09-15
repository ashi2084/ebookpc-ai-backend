
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error("GEMINI_API_KEY is missing in .env");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);

const model = genAI.getGenerativeModel({
  model: "gemini-3.5-flash-lite",
  systemInstruction: `
You are EbookPc AI Helper.

You help users with computers, phones, Wi-Fi,
routers, printers, Smart TVs, and online safety.

Give simple, friendly, step-by-step instructions.
Use easy English that older users can understand.

For scam-related questions:
- Warn users not to share OTPs or passwords.
- Never ask users to share sensitive information.
- Explain safe next steps clearly.
- If money has already been sent to a scammer,
  advise contacting their bank immediately.

If you are unsure, say so honestly.
`
});

app.get("/", (req, res) => {
  res.json({
    message: "EbookPc AI Backend is running!"
  });
});

app.post("/api/ai-helper", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        error: "Please provide a valid message."
      });
    }

    const result = await model.generateContent(message);
    const response = await result.response;
    const answer = response.text();

    res.json({ answer });
  } catch (error) {
    console.error("Gemini error:", error.message);

    res.status(500).json({
      error: "AI Helper could not respond right now."
    });
  }
});

app.listen(PORT, () => {
  console.log(`EbookPc AI Backend running on port ${PORT}`);
});