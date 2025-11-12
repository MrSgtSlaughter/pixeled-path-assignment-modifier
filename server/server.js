import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { google } from "googleapis";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.json());

// OpenAI client
if (!process.env.OPENAI_API_KEY) {
  console.warn("WARNING: OPENAI_API_KEY is not set. Requests will fail.");
}
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Google Drive auth (service account / default credentials)
// This creates docs in the project service account's Drive.
const driveAuth = new google.auth.GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/drive.file"],
});

// Helpers
function extractDocId(docUrl) {
  const match = docUrl.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

async function fetchGoogleDocText(docUrl) {
  const docId = extractDocId(docUrl);
  if (!docId) {
    throw new Error("Could not extract Google Doc ID from URL.");
  }

  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;

  const response = await fetch(exportUrl);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to fetch Google Doc. Status ${response.status}. ` +
        `Check that sharing is set to 'Anyone with the link can view'. ${body.slice(0, 200)}`
    );
  }

  const text = await response.text();
  if (!text || text.trim().length === 0) {
    throw new Error("Google Doc appears to be empty or not accessible as text.");
  }

  return text;
}

function buildPrompt(docText, profiles, supports) {
  const profileLine = profiles.length ? profiles.join(", ") : "unspecified";
  const supportsLine = supports.length ? supports.join(", ") : "standard accommodations";

  return `
You are a veteran special education and ESL co-teacher.
You modify secondary-level assignments for students with ESL/ELL, IEP, and 504 needs.

The teacher has provided an original assignment from a Google Doc.
Your job is to produce a FULLY MODIFIED version that a teacher can give directly to students.

STUDENT PROFILE(S): ${profileLine}
REQUESTED SUPPORTS: ${supportsLine}

ORIGINAL ASSIGNMENT (from Google Doc):
--------------------
${docText.slice(0, 12000)}
--------------------

REQUIREMENTS:

1. DO NOT just summarize the assignment. Keep the core task and content.
2. Simplify language where needed, without talking down to students.
3. Make the directions extremely clear and step-by-step.
4. Build in explicit supports suited to the profiles above.

STRUCTURE YOUR RESPONSE AS JSON ONLY, WITH THIS SHAPE:

{
  "title": "Short modified assignment title",
  "notesForTeacher": [
    "Note 1 for the teacher about how to use this",
    "Note 2..."
  ],
  "sections": [
    {
      "title": "Student-Friendly Directions",
      "body": [
        "Bullet or numbered direction 1 in student-friendly language.",
        "Direction 2...",
        "etc."
      ]
    },
    {
      "title": "Chunked Steps",
      "body": [
        "Step 1: ...",
        "Step 2: ...",
        "..."
      ]
    },
    {
      "title": "Vocabulary & Language Support",
      "body": [
        "Word Bank:",
        "- term: simple definition",
        "- term: simple definition",
        "Sentence frames:",
        "- I learned that...",
        "- The most important idea is..."
      ]
    },
    {
      "title": "Scaffolds & Options",
      "body": [
        "Examples of sentence frames, reduced writing options, checklists, etc.",
        "You can give students a choice board of 2–3 output options, all easier than the original."
      ]
    },
    {
      "title": "Student Checklist",
      "body": [
        "[ ] I read or listened to the text.",
        "[ ] I completed the warm-up question.",
        "[ ] I used at least one sentence frame.",
        "[ ] I checked my work."
      ]
    }
  ]
}

Rules:
- Output VALID JSON ONLY. No explanations, no markdown, no backticks.
- Keep language appropriate for middle-school reading level unless the text clearly targets older students.
- Do not include the original assignment text in the output.
`;
}

function assignmentToPlainText(assignment) {
  const lines = [];

  if (assignment.title) {
    lines.push(assignment.title.toUpperCase());
    lines.push("");
  }

  if (Array.isArray(assignment.notesForTeacher) && assignment.notesForTeacher.length) {
    lines.push("NOTES FOR TEACHER:");
    assignment.notesForTeacher.forEach((note) => {
      lines.push(`- ${note}`);
    });
    lines.push("");
  }

  if (Array.isArray(assignment.sections)) {
    assignment.sections.forEach((section) => {
      const title = section.title || "Section";
      lines.push(title);
      lines.push("-".repeat(title.length));

      const body = Array.isArray(section.body)
        ? section.body
        : [String(section.body || "")];

      body.forEach((line) => {
        lines.push(line);
      });

      lines.push("");
    });
  }

  return lines.join("\n");
}

// Routes

app.post("/api/modify", async (req, res) => {
  try {
    const { docUrl, profiles = [], supports = [] } = req.body || {};

    if (!docUrl || typeof docUrl !== "string") {
      return res.status(400).json({ ok: false, error: "docUrl is required and must be a string." });
    }

    if (!docUrl.includes("docs.google.com")) {
      return res.status(400).json({ ok: false, error: "docUrl must be a Google Docs link." });
    }

    console.log("[/api/modify] Incoming request", { docUrl, profiles, supports });

    const docText = await fetchGoogleDocText(docUrl);
    const prompt = buildPrompt(docText, profiles, supports);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are an expert special education and ESL co-teacher. You only return valid JSON, no extra commentary.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) {
      throw new Error("Model returned empty response.");
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error("Failed to parse JSON from model:", raw.slice(0, 400));
      throw new Error("Model output was not valid JSON.");
    }

    res.json({
      ok: true,
      profiles,
      supports,
      docUrl,
      result: parsed,
    });
  } catch (err) {
    console.error("Error in /api/modify:", err);
    res.status(500).json({
      ok: false,
      error: err.message || "Internal server error.",
    });
  }
});

app.post("/api/create-doc", async (req, res) => {
  try {
    const { assignment } = req.body || {};

    if (!assignment || typeof assignment !== "object") {
      return res.status(400).json({
        ok: false,
        error: "assignment object is required.",
      });
    }

    const textContent = assignmentToPlainText(assignment);
    if (!textContent.trim()) {
      return res.status(400).json({
        ok: false,
        error: "Assignment content is empty.",
      });
    }

    const authClient = await driveAuth.getClient();
    const drive = google.drive({ version: "v3", auth: authClient });

    const fileMetadata = {
      name: assignment.title || "Modified Assignment",
      mimeType: "application/vnd.google-apps.document",
    };

    const media = {
      mimeType: "text/plain",
      body: textContent,
    };

    const fileResponse = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: "id, webViewLink",
    });

    const file = fileResponse.data;

    await drive.permissions.create({
      fileId: file.id,
      requestBody: {
        role: "reader",
        type: "anyone",
      },
    });

    return res.json({
      ok: true,
      docId: file.id,
      url: file.webViewLink,
    });
  } catch (err) {
    console.error("Error in /api/create-doc:", err);
    res.status(500).json({
      ok: false,
      error: err.message || "Failed to create Google Doc.",
    });
  }
});

app.get("/", (req, res) => {
  res.send("PixelED Path Assignment Modifier API is running.");
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
