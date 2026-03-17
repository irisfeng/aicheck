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

## Recommended File Naming

Use review-item codes as filename prefixes whenever possible:

- `2.8.1.1.png`
- `2.8.1.1-1.png`
- `2.8.1.1-2.png`
- `2.8.2.3-1-IP白名单.png`
- `安扫报告.pdf`

The backend will automatically route files with checklist-style prefixes to the
matching item. Files named like `安扫报告.pdf` are treated as global evidence.

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
