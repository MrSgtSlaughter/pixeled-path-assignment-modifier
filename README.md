# PixelED Path Assignment Modifier

This repo contains:

- `docs/` — static front-end for GitHub Pages.
- `server/` — Node.js backend (Express) with:
  - `POST /api/modify` — takes a Google Doc link and returns a modified assignment JSON.
  - `POST /api/create-doc` — takes that JSON and creates a Google Doc via Google Drive API.

## Front-end (GitHub Pages)

1. Push this repo to GitHub.
2. In the repo settings, enable **GitHub Pages** from the `docs/` folder.
3. Update the `API_BASE` constant in `docs/index.html` to point at your deployed backend URL, e.g.:

```js
const API_BASE = "https://your-backend-service.onrender.com";
```

## Backend (Node / Express)

From the `server/` folder:

```bash
npm install
```

Create `.env`:

```env
OPENAI_API_KEY=sk-...
PORT=4000
```

Then run locally:

```bash
npm start
```

You now have:

- `http://localhost:4000/api/modify`
- `http://localhost:4000/api/create-doc`

Deploy `server/` to your hosting of choice (Render, Railway, Fly, etc.).  
Set `OPENAI_API_KEY` and `PORT` as environment variables there.

### Google Doc requirements

- Original assignment must be a Google Doc with sharing set to **“Anyone with the link can view”**.
- The backend uses the public export endpoint to grab plain text.

### Create Modified Google Doc

The `/api/create-doc` endpoint:

- Takes the structured JSON assignment.
- Turns it into text.
- Creates a Google Doc in the project’s service account Drive.
- Sets share permission to **Anyone with the link can view**.
- Returns `url` to open the doc.
