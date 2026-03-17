import "dotenv/config";
import cors from "cors";
import express from "express";
import multer from "multer";
import { loadChecklist } from "./checklist.mjs";
import { extractDocumentText } from "./document-extractor.mjs";
import {
  enrichImage,
  getProviderLabel,
  isApiConfigured,
  ocrImage,
  reviewChecklist,
} from "./dashscope.mjs";

const app = express();
const port = Number(process.env.PORT || 8787);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: 20,
  },
});

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    provider: getProviderLabel(),
    apiConfigured: isApiConfigured(),
  });
});

app.post("/api/analyze", upload.array("files", 20), async (req, res) => {
  try {
    if (!isApiConfigured()) {
      return res.status(400).json({
        error:
          "尚未配置 DASHSCOPE_API_KEY。请先复制 .env.example 为 .env 并填写百炼 API Key。",
      });
    }

    const checklistPayload = await loadChecklist();
    const checklist = checklistPayload.items;
    const caseName = String(req.body.caseName || "内部审核案件");
    const notes = String(req.body.notes || "");
    const files = req.files || [];

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: "请至少上传一个文件。" });
    }

    const evidences = [];

    for (const file of files) {
      const base = {
        id: `${file.originalname}-${file.size}-${Date.now()}`,
        fileName: file.originalname,
        mimeType: file.mimetype,
      };

      if (file.mimetype.startsWith("image/")) {
        const extractedText = await ocrImage(file);
        const visionSummary = await enrichImage(file);
        evidences.push({
          ...base,
          source: "ocr",
          extractedText,
          summary: visionSummary || "已通过百炼 OCR 提取图片文字。",
        });
        continue;
      }

      const documentResult = await extractDocumentText(file);
      evidences.push({
        ...base,
        source: documentResult.source,
        extractedText: documentResult.text,
        summary: documentResult.summary,
      });
    }

    const reviewResult = await reviewChecklist({
      caseName,
      notes,
      checklist,
      evidences,
    });

    res.json({
      provider: getProviderLabel(),
      caseName,
      evidences,
      summary: reviewResult.summary,
      items: reviewResult.items,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "分析失败，请查看服务端日志。",
    });
  }
});

app.listen(port, () => {
  console.log(`AICheck server running at http://localhost:${port}`);
});
