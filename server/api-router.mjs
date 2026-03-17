import express from "express";
import multer from "multer";
import { login, logout, requireAuth } from "./auth.mjs";
import { loadChecklist } from "./checklist.mjs";
import { extractDocumentText } from "./document-extractor.mjs";
import {
  enrichImage,
  getProviderLabel,
  isApiConfigured,
  ocrImage,
  reviewChecklist,
  reviewMandatoryItemWithVision,
} from "./dashscope.mjs";
import { buildEvidenceIndex, inferEvidenceRouting } from "./evidence-routing.mjs";
import {
  getReviewCase,
  getStorageLabel,
  isDatabaseConfigured,
  listReviewCases,
  saveReviewCase,
} from "./storage.mjs";
import {
  createUploadTargets,
  getObjectStorageLabel,
  isObjectStorageConfigured,
  readUploadedObjects,
} from "./object-storage.mjs";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: 20,
  },
});

const severityRank = {
  pass: 0,
  pending: 1,
  manual_review_required: 2,
  insufficient_evidence: 2,
  fail: 3,
};

function pickConservativeResult(baseResult, visionResult, mandatory) {
  if (!baseResult) return visionResult;
  if (!visionResult || !mandatory) return baseResult;

  const baseRank = severityRank[baseResult.status] ?? 0;
  const visionRank = severityRank[visionResult.status] ?? 0;
  const useVision = visionRank > baseRank;

  const chosen = useVision ? visionResult : baseResult;
  const secondaryBasis = useVision ? baseResult.basis : visionResult.basis;
  const mergedBasis = [
    ...(Array.isArray(chosen.basis) ? chosen.basis : []),
    ...(Array.isArray(secondaryBasis) ? secondaryBasis : []),
  ];

  return {
    ...chosen,
    confidence: chosen.confidence ?? baseResult.confidence ?? 0,
    rationale: useVision
      ? `${visionResult.rationale}\n\n[视觉复判] 已对必须项采用更保守的视觉结论。`
      : visionResult.status !== baseResult.status
        ? `${baseResult.rationale}\n\n[视觉复判] 已参考视觉模型结果，但当前保留综合后更稳妥的结论。`
        : baseResult.rationale,
    basis: [...new Set(mergedBasis.filter(Boolean))],
    remediation: chosen.remediation || baseResult.remediation || "暂无。",
    referenceMethod:
      chosen.referenceMethod || baseResult.referenceMethod || "暂无参考做法。",
    evidenceFiles: [
      ...new Set([
        ...(Array.isArray(baseResult.evidenceFiles) ? baseResult.evidenceFiles : []),
        ...(Array.isArray(visionResult.evidenceFiles) ? visionResult.evidenceFiles : []),
      ]),
    ],
  };
}

async function runMandatoryVisionRechecks({
  checklist,
  evidenceIndex,
  fileMap,
  notes,
}) {
  const results = {};

  for (const item of checklist.filter((entry) => entry.mandatory)) {
    const directEvidence = evidenceIndex.directByCode[item.code] ?? [];
    const imageFiles = directEvidence
      .filter((evidence) => evidence.mimeType.startsWith("image/"))
      .map((evidence) => fileMap.get(evidence.id))
      .filter(Boolean);

    if (imageFiles.length === 0) {
      continue;
    }

    const ocrSnippets = directEvidence.map((evidence) => ({
      fileName: evidence.fileName,
      extractedText: evidence.extractedText.slice(0, 1500),
      summary: evidence.summary,
    }));

    try {
      const visionResult = await reviewMandatoryItemWithVision({
        item,
        imageFiles,
        ocrSnippets,
        notes,
      });

      if (visionResult) {
        results[item.code] = visionResult;
      }
    } catch (error) {
      console.error(`Vision recheck failed for ${item.code}:`, error);
    }
  }

  return results;
}

function buildRecommendedDecision(items, mandatoryItems) {
  const mandatoryCodes = new Set(mandatoryItems.map((item) => item.code));
  const blockerCount = items.filter(
    (item) => mandatoryCodes.has(item.code) && item.status === "fail",
  ).length;
  const unresolvedCount = items.filter((item) =>
    ["insufficient_evidence", "manual_review_required", "pending"].includes(item.status),
  ).length;
  const mandatoryPassCount = items.filter(
    (item) => mandatoryCodes.has(item.code) && item.status === "pass",
  ).length;

  let recommendedDecision = "可进入人工终审";
  if (blockerCount > 0) {
    recommendedDecision = "建议驳回";
  } else if (
    items.some((item) =>
      ["insufficient_evidence", "manual_review_required"].includes(item.status),
    )
  ) {
    recommendedDecision = "待补件 / 待人工复核";
  }

  return {
    recommendedDecision,
    blockerCount,
    unresolvedCount,
    mandatoryPassCount,
    totalMandatoryCount: mandatoryItems.length,
  };
}

function buildFallbackItem(item, directFiles) {
  const hasDirectFiles = directFiles.length > 0;
  return {
    code: item.code,
    status: item.mandatory ? "insufficient_evidence" : "manual_review_required",
    confidence: 0,
    rationale: "模型未返回该审查项结果，系统已按保守策略回退。",
    basis: hasDirectFiles
      ? [`已命中材料：${directFiles.join("、")}`, "但模型未返回可用判定结果。"]
      : ["未找到与该审查项直接对应的命名材料。"],
    remediation: hasDirectFiles
      ? "请专家复核现有材料，必要时补充更完整的配置截图。"
      : "请补充与该编号对应的截图，至少覆盖关键配置页、状态页或策略明细页。",
    referenceMethod: hasDirectFiles
      ? "建议补充同一配置项的完整页面截图，包含标题、字段值和保存状态。"
      : "建议按“审查项编号-序号-说明”的格式补充截图，例如 2.8.1.1-1-密码策略.png。",
    evidenceFiles: directFiles,
    nextAction: hasDirectFiles ? "请人工复核现有证据材料。" : "请补充与该编号对应的截图或说明材料。",
  };
}

function normalizeReviewItems({
  checklist,
  evidenceIndex,
  reviewResult,
  visionAssessments,
}) {
  return checklist.map((item) => {
    const modelItem = reviewResult.items?.find((entry) => entry.code === item.code);
    const visionItem = visionAssessments[item.code] ?? null;
    const directFiles = (evidenceIndex.directByCode[item.code] ?? []).map(
      (evidence) => evidence.fileName,
    );

    const baseItem = modelItem
      ? {
          ...modelItem,
          basis:
            Array.isArray(modelItem.basis) && modelItem.basis.length > 0
              ? modelItem.basis
              : directFiles.length > 0
                ? [`已关联材料：${directFiles.join("、")}`]
                : ["暂无直接依据。"],
          remediation: modelItem.remediation || "暂无。",
          referenceMethod: modelItem.referenceMethod || "暂无参考做法。",
          evidenceFiles:
            Array.isArray(modelItem.evidenceFiles) && modelItem.evidenceFiles.length > 0
              ? [...new Set(modelItem.evidenceFiles)]
              : directFiles,
        }
      : buildFallbackItem(item, directFiles);

    return pickConservativeResult(baseItem, visionItem, item.mandatory);
  });
}

function attachPersistenceMeta(payload, persistence) {
  return {
    ...payload,
    caseId: persistence.caseId,
    createdAt: persistence.createdAt,
    updatedAt: persistence.updatedAt,
  };
}

async function collectRequestFiles(req) {
  const uploadedFiles = Array.isArray(req.body?.uploadedFiles) ? req.body.uploadedFiles : [];

  if (uploadedFiles.length > 0) {
    return readUploadedObjects(
      uploadedFiles.map((file) => ({
        fileName: String(file?.fileName || "").trim(),
        mimeType: String(file?.mimeType || "application/octet-stream"),
        size: Number(file?.size || 0),
        objectKey: String(file?.objectKey || "").trim(),
      })),
    );
  }

  return req.files || [];
}

export function createApiRouter() {
  const router = express.Router();
  router.use(express.json({ limit: "4mb" }));

  router.get("/health", (_req, res) => {
    res.json({
      ok: true,
      provider: getProviderLabel(),
      apiConfigured: isApiConfigured(),
      databaseConfigured: isDatabaseConfigured(),
      storage: getStorageLabel(),
      objectStorageConfigured: isObjectStorageConfigured(),
      objectStorage: getObjectStorageLabel(),
    });
  });

  router.post("/auth/login", async (req, res) => {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const session = await login(username, password);

    if (!session) {
      return res.status(401).json({
        error: "用户名或密码不正确。",
      });
    }

    res.json(session);
  });

  router.get("/auth/me", requireAuth, (req, res) => {
    res.json({
      user: req.auth.user,
    });
  });

  router.post("/auth/logout", requireAuth, (_req, res) => {
    res.json(logout());
  });

  router.post("/uploads/sign", requireAuth, async (req, res) => {
    try {
      if (!isObjectStorageConfigured()) {
        return res.status(400).json({
          error: "Cloudflare R2 尚未配置，当前不能直传文件。",
        });
      }

      const files = Array.isArray(req.body?.files) ? req.body.files : [];
      if (files.length === 0) {
        return res.status(400).json({ error: "缺少待上传文件元数据。" });
      }

      if (files.length > 20) {
        return res.status(400).json({ error: "单次最多上传 20 个文件。" });
      }

      const normalizedFiles = files.map((file) => ({
        fileName: String(file?.fileName || "").trim(),
        mimeType: String(file?.mimeType || "application/octet-stream"),
        size: Number(file?.size || 0),
      }));

      if (normalizedFiles.some((file) => !file.fileName || file.size <= 0)) {
        return res.status(400).json({ error: "文件元数据不完整。" });
      }

      const uploads = await createUploadTargets({
        files: normalizedFiles,
        caseId: String(req.body?.caseId || "").trim() || "temp",
        username: req.auth.user.username,
      });

      res.json({
        uploads,
        provider: getObjectStorageLabel(),
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "生成上传地址失败。",
      });
    }
  });

  router.get("/cases", requireAuth, async (req, res) => {
    try {
      const cases = await listReviewCases(req.auth.user);
      res.json({ cases });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "读取案件列表失败。",
      });
    }
  });

  router.get("/cases/:caseId", requireAuth, async (req, res) => {
    try {
      const reviewCase = await getReviewCase(req.params.caseId, req.auth.user);
      if (!reviewCase) {
        return res.status(404).json({ error: "未找到该案件，或当前账号无权访问。" });
      }

      res.json(reviewCase);
    } catch (error) {
      console.error(error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "读取案件详情失败。",
      });
    }
  });

  router.put("/cases/:caseId/review", requireAuth, async (req, res) => {
    try {
      const reviewPayload = req.body?.review;
      if (!reviewPayload || typeof reviewPayload !== "object") {
        return res.status(400).json({ error: "缺少 review 数据。" });
      }

      const caseName = String(req.body?.caseName || reviewPayload.caseName || "").trim();
      if (!caseName) {
        return res.status(400).json({ error: "缺少案件名称。" });
      }

      const notes = String(req.body?.notes || reviewPayload.notes || "");
      const persistence = await saveReviewCase({
        caseId: req.params.caseId,
        caseName,
        notes,
        provider: reviewPayload.provider || getProviderLabel(),
        actor: req.auth.user,
        reviewData: {
          ...reviewPayload,
          caseName,
          notes,
          actor: req.auth.user,
        },
      });

      res.json({
        ok: true,
        caseId: persistence.caseId,
        createdAt: persistence.createdAt,
        updatedAt: persistence.updatedAt,
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "保存人工复核结果失败。",
      });
    }
  });

  router.post("/analyze", requireAuth, upload.array("files", 20), async (req, res) => {
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
      const uploadedFiles = Array.isArray(req.body?.uploadedFiles) ? req.body.uploadedFiles : [];
      const files = await collectRequestFiles(req);

      if (!Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: "请至少上传一个文件。" });
      }

      const evidences = [];
      const fileMap = new Map();

      for (const file of files) {
        const routing = inferEvidenceRouting(file.originalname, checklistCodes);
        const evidenceId = `${file.originalname}-${file.size}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        const base = {
          id: evidenceId,
          fileName: file.originalname,
          mimeType: file.mimetype,
          linkedCodes: routing.linkedCodes,
          globalEvidence: routing.globalEvidence,
          namingHint: routing.namingHint,
        };
        fileMap.set(evidenceId, file);

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
      const visionAssessments = await runMandatoryVisionRechecks({
        checklist,
        evidenceIndex,
        fileMap,
        notes,
      });

      const reviewResult = await reviewChecklist({
        caseName,
        notes,
        checklist,
        evidenceIndex,
        visionAssessments,
      });

      const normalizedItems = normalizeReviewItems({
        checklist,
        evidenceIndex,
        reviewResult,
        visionAssessments,
      });
      const mandatoryItems = checklist.filter((item) => item.mandatory);
      const summary = {
        ...buildRecommendedDecision(normalizedItems, mandatoryItems),
        overview:
          reviewResult.summary?.overview ??
          `已完成 ${normalizedItems.length} 条审查项初判，其中必须项通过 ${
            normalizedItems.filter(
              (entry) =>
                mandatoryItems.some((item) => item.code === entry.code) &&
                entry.status === "pass",
            ).length
          }/${mandatoryItems.length}。`,
      };

      const reviewPayload = {
        provider: getProviderLabel(),
        caseName,
        notes,
        actor: req.auth.user,
        uploadedFiles,
        evidences,
        summary,
        items: normalizedItems,
      };

      const persistence = await saveReviewCase({
        caseId: String(req.body.caseId || "").trim() || undefined,
        caseName,
        notes,
        provider: getProviderLabel(),
        actor: req.auth.user,
        reviewData: reviewPayload,
      });

      res.json(attachPersistenceMeta(reviewPayload, persistence));
    } catch (error) {
      console.error(error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "分析失败，请查看服务端日志。",
      });
    }
  });

  return router;
}
