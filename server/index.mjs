import "dotenv/config";
import cors from "cors";
import express from "express";
import multer from "multer";
import { login, logout, readBearerToken, requireAuth } from "./auth.mjs";
import { loadChecklist } from "./checklist.mjs";
import { extractDocumentText } from "./document-extractor.mjs";
import {
  enrichImage,
  getProviderLabel,
  isApiConfigured,
  ocrImage,
  reviewChecklist,
} from "./dashscope.mjs";
import { buildEvidenceIndex, inferEvidenceRouting } from "./evidence-routing.mjs";

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

app.post("/api/auth/login", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const session = login(username, password);

  if (!session) {
    return res.status(401).json({
      error: "用户名或密码不正确。",
    });
  }

  res.json(session);
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({
    user: req.auth.user,
  });
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  logout(req.auth.token);
  res.json({ ok: true });
});

app.post("/api/analyze", requireAuth, upload.array("files", 20), async (req, res) => {
  try {
    if (!isApiConfigured()) {
      return res.status(400).json({
        error:
          "尚未配置 DASHSCOPE_API_KEY。请先复制 .env.example 为 .env 并填写百炼 API Key。",
      });
    }

    const checklistPayload = await loadChecklist();
    const checklist = checklistPayload.items;
    const checklistCodes = new Set(checklist.map((item) => item.code));
    const caseName = String(req.body.caseName || "语音业务接入审核案件");
    const notes = String(req.body.notes || "");
    const files = req.files || [];

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: "请至少上传一个文件。" });
    }

    const evidences = [];

    for (const file of files) {
      const routing = inferEvidenceRouting(file.originalname, checklistCodes);
      const base = {
        id: `${file.originalname}-${file.size}-${Date.now()}`,
        fileName: file.originalname,
        mimeType: file.mimetype,
        linkedCodes: routing.linkedCodes,
        globalEvidence: routing.globalEvidence,
        namingHint: routing.namingHint,
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

    const evidenceIndex = buildEvidenceIndex(checklist, evidences);
    const reviewResult = await reviewChecklist({
      caseName,
      notes,
      checklist,
      evidenceIndex,
    });

    const normalizedItems = checklist.map((item) => {
      const modelItem = reviewResult.items?.find((entry) => entry.code === item.code);
      const directFiles = (evidenceIndex.directByCode[item.code] ?? []).map(
        (evidence) => evidence.fileName,
      );

      if (!modelItem) {
        return {
          code: item.code,
          status: item.mandatory
            ? "insufficient_evidence"
            : "manual_review_required",
          confidence: 0,
          rationale: "模型未返回该审查项结果，系统已按保守策略回退。",
          basis: directFiles.length
            ? [`已命中材料：${directFiles.join("、")}`, "但模型未返回可用判定结果。"]
            : ["未找到与该审查项直接对应的命名材料。"],
          remediation: directFiles.length
            ? "请专家复核现有材料，必要时补充更完整的配置截图。"
            : "请补充与该编号对应的截图，至少覆盖关键配置页、状态页或策略明细页。",
          referenceMethod: directFiles.length
            ? "建议补充同一配置项的完整页面截图，包含标题、字段值和保存状态。"
            : "建议按“审查项编号-序号-说明”的格式补充截图，例如 2.8.1.1-1-密码策略.png。",
          evidenceFiles: directFiles,
          nextAction: directFiles.length
            ? "请人工复核现有佐证材料。"
            : "请补充与该编号对应的截图或说明材料。",
        };
      }

      return {
        ...modelItem,
        basis:
          Array.isArray(modelItem.basis) && modelItem.basis.length > 0
            ? modelItem.basis
            : directFiles.length > 0
              ? [`已关联材料：${directFiles.join("、")}`]
              : ["暂无直接依据。"],
        remediation: modelItem.remediation || "暂无。",
        referenceMethod: modelItem.referenceMethod || "暂无。",
        evidenceFiles:
          Array.isArray(modelItem.evidenceFiles) && modelItem.evidenceFiles.length > 0
            ? [...new Set(modelItem.evidenceFiles)]
            : directFiles,
      };
    });

    const mandatoryItems = checklist.filter((item) => item.mandatory);
    const mandatoryPassCount = mandatoryItems.filter((item) => {
      return normalizedItems.find((entry) => entry.code === item.code)?.status === "pass";
    }).length;
    const blockerCount = mandatoryItems.filter((item) => {
      const status = normalizedItems.find((entry) => entry.code === item.code)?.status;
      return status === "fail";
    }).length;
    const unresolvedCount = normalizedItems.filter((item) => {
      return (
        item.status === "insufficient_evidence" ||
        item.status === "manual_review_required" ||
        item.status === "pending"
      );
    }).length;

    let recommendedDecision = "可进入人工终审";
    if (blockerCount > 0) {
      recommendedDecision = "建议驳回";
    } else if (
      normalizedItems.some(
        (item) =>
          item.status === "insufficient_evidence" ||
          item.status === "manual_review_required",
      )
    ) {
      recommendedDecision = "待补件 / 待人工复核";
    }

    const summary = {
      recommendedDecision,
      blockerCount,
      unresolvedCount,
      mandatoryPassCount,
      totalMandatoryCount: mandatoryItems.length,
      overview:
        reviewResult.summary?.overview ??
        `已完成 ${normalizedItems.length} 条审查项初判，其中必须项通过 ${mandatoryPassCount}/${mandatoryItems.length}。`,
    };

    res.json({
      provider: getProviderLabel(),
      caseName,
      actor: req.auth.user,
      evidences,
      summary,
      items: normalizedItems,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "分析失败，请查看服务端日志。",
    });
  }
});

app.listen(port, () => {
  console.log(`Voice review desk running at http://localhost:${port}`);
  console.log(
    `Demo accounts: ${process.env.DEMO_OPERATOR_USERNAME ?? "operator"} / ${
      process.env.DEMO_OPERATOR_PASSWORD ?? "operator123"
    }, ${process.env.DEMO_EXPERT_USERNAME ?? "expert"} / ${
      process.env.DEMO_EXPERT_PASSWORD ?? "expert123"
    }`,
  );
});
