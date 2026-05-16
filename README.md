# mtgnews

MTG News & Sentiment Scanner — monitors YouTube channels for MTG content, extracts captions, and analyzes sentiment via LLM.

## Prerequisites

- Node.js 18+
- npm
- `yt-dlp` installed and on PATH (for caption extraction)

## Setup

```bash
npm install
```

## Run

```bash
npm run dev
```

Starts Express dashboard + background polling worker on `http://localhost:3000`.

The frontend is server-rendered (EJS templates) — no separate build step or client dev server needed. Opening `http://localhost:3000` loads the full UI.

## Test

```bash
npm test
```

## Test (watch mode)

```bash
npm run test:watch
```
