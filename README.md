# 语音业务对接入网技术审核台

Internal MVP for AI-assisted voice-business access review.

## What It Does

- Two-role login: operator and expert
- Upload evidence files
- Extract text from images and documents
- Send extracted evidence to DashScope / Bailian APIs
- Produce item-by-item checklist judgments
- Let expert reviewers override results inside the UI

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
3. Optionally adjust the demo login accounts
4. Install dependencies:

```bash
npm install
```

5. Start client and server:

```bash
npm run dev
```

6. Open `http://localhost:5173`

## Minimal Workflow

1. 普通上传审核账号登录
2. 上传按编号命名的截图和安扫报告
3. 触发 AI 初判并查看逐条结果
4. 专家人工审核账号登录并复核重点条目
5. 专家执行人工覆盖并导出审核结论

## Notes

- This MVP is intentionally narrow: internal use, core workflow first.
- OCR and review are API-driven. No local OCR or local LLM is required.
- `memory/` stores daily development progress logs by date.
