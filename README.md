# AICheck MVP

Internal MVP for AI-assisted security checklist review.

## What It Does

- Upload evidence files
- Extract text from images and documents
- Send extracted evidence to DashScope / Bailian APIs
- Produce item-by-item checklist judgments
- Let reviewers override results inside the UI

## Supported Input Types In This MVP

- Images: `.png`, `.jpg`, `.jpeg`, `.webp`
- Documents: `.pdf`, `.docx`, `.txt`, `.md`, `.json`

## Quick Start

1. Copy `.env.example` to `.env`
2. Fill `DASHSCOPE_API_KEY`
3. Install dependencies:

```bash
npm install
```

4. Start client and server:

```bash
npm run dev
```

5. Open `http://localhost:5173`

## Notes

- This MVP is intentionally narrow: internal use, core workflow first.
- OCR and review are API-driven. No local OCR or local LLM is required.
- `memory/` stores daily development progress logs by date.
