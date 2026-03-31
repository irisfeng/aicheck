import express from "express";
import multer from "multer";
import { login, logout, requireAuth } from "./auth.mjs";
import { loadChecklist } from "./checklist.mjs";
import { extractDocumentText } from "./document-extractor.mjs";
import {
  analyzeSecurityScanReport,
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
import {
  consumeRateLimit,
  createRateLimitMiddleware,
  getClientIp,
  getRateLimitStatus,
  resetRateLimit,
} from "./rate-limit.mjs";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: 20,
  },
});

const analyzeRateLimit = createRateLimitMiddleware({
  key: "analyze",
  windowMs: Number(process.env.ANALYZE_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000),
  max: Number(process.env.ANALYZE_RATE_LIMIT_MAX || 20),
  message: "分析请求过于频繁，请稍后再试。",
});

const severityRank = {
  pass: 0,
  pending: 1,
  manual_review_required: 2,
  insufficient_evidence: 2,
  fail: 3,
};

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  const concurrency = Math.max(1, Math.min(limit, items.length || 1));
  let index = 0;

  async function worker() {
    while (true) {
      const currentIndex = index;
      index += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

function sanitizeWorkflowUser(user) {
  if (!user) return undefined;

  return {
    username: user.username,
    displayName: user.displayName,
    role: user.role,
  };
}

function normalizeWorkflow(workflow) {
  if (!workflow || typeof workflow !== "object") {
    return {
      status: "draft",
    };
  }

  return {
    status: workflow.status || "draft",
    submittedToExpertAt: workflow.submittedToExpertAt || undefined,
    submittedToExpertBy: sanitizeWorkflowUser(workflow.submittedToExpertBy),
    expertReviewedAt: workflow.expertReviewedAt || undefined,
    expertReviewedBy: sanitizeWorkflowUser(workflow.expertReviewedBy),
  };
}

function createPendingExpertWorkflow(actor) {
  return {
    status: "pending_expert_review",
    submittedToExpertAt: new Date().toISOString(),
    submittedToExpertBy: sanitizeWorkflowUser(actor),
  };
}

function createExpertReviewedWorkflow(actor, existingWorkflow) {
  const current = normalizeWorkflow(existingWorkflow);

  return {
    status: "expert_reviewed",
    submittedToExpertAt: current.submittedToExpertAt || new Date().toISOString(),
    submittedToExpertBy:
      current.submittedToExpertBy || sanitizeWorkflowUser(actor),
    expertReviewedAt: new Date().toISOString(),
    expertReviewedBy: sanitizeWorkflowUser(actor),
  };
}

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
  const concurrency = Number(process.env.DASHSCOPE_MANDATORY_VISION_CONCURRENCY || 2);
  const mandatoryItems = checklist.filter((entry) => entry.mandatory);

  await mapWithConcurrency(mandatoryItems, concurrency, async (item) => {
    const directEvidence = evidenceIndex.directByCode[item.code] ?? [];
    const imageFiles = directEvidence
      .filter((evidence) => evidence.mimeType.startsWith("image/"))
      .map((evidence) => fileMap.get(evidence.id))
      .filter(Boolean);

    if (imageFiles.length === 0) {
      return;
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
  });

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

function buildMandatoryCollection(checklist, items) {
  const mandatoryItems = checklist.filter((item) => item.mandatory);
  const resultMap = new Map((items || []).map((item) => [item.code, item]));
  const missingItems = mandatoryItems.filter((item) => {
    const result = resultMap.get(item.code);
    return (result?.evidenceFiles?.length ?? 0) === 0;
  });

  return {
    mandatoryCollectedCount: mandatoryItems.length - missingItems.length,
    mandatoryReadyForExpert: missingItems.length === 0,
    mandatoryMissingCodes: missingItems.map((item) => item.code),
  };
}

function shouldLockPassingItems(existingCase) {
  const workflowStatus = normalizeWorkflow(existingCase?.workflow).status;
  return (
    Array.isArray(existingCase?.items) &&
    existingCase.items.length > 0 &&
    ["pending_expert_review", "expert_reviewed"].includes(workflowStatus)
  );
}

function buildIncrementalReviewScope({
  checklist,
  previousItems = [],
  currentBatchEvidences = [],
}) {
  const unresolvedCodes = new Set(
    (previousItems || [])
      .filter((item) => item?.code && item.status !== "pass")
      .map((item) => item.code),
  );
  const preservedPassCodes = (previousItems || [])
    .filter((item) => item?.code && item.status === "pass")
    .map((item) => item.code);
  const reviewedCodeSet = new Set();
  const scanRelatedCodes = checklist
    .filter((item) => isSecurityScanChecklistItem(item))
    .map((item) => item.code);
  const hasGlobalEvidence = (currentBatchEvidences || []).some(
    (evidence) => evidence?.globalEvidence,
  );

  for (const evidence of currentBatchEvidences || []) {
    for (const code of evidence?.linkedCodes || []) {
      if (unresolvedCodes.has(code)) {
        reviewedCodeSet.add(code);
      }
    }
  }

  if (hasGlobalEvidence) {
    for (const code of scanRelatedCodes) {
      if (unresolvedCodes.has(code)) {
        reviewedCodeSet.add(code);
      }
    }
  }

  return {
    unresolvedCodes: [...unresolvedCodes],
    preservedPassCodes,
    reviewedCodes: [...reviewedCodeSet],
    reviewChecklist: checklist.filter((item) => reviewedCodeSet.has(item.code)),
  };
}

function mergeReviewItems({
  checklist,
  previousItems = [],
  nextItems = [],
  evidenceIndex,
}) {
  const previousItemMap = new Map((previousItems || []).map((item) => [item.code, item]));
  const nextItemMap = new Map((nextItems || []).map((item) => [item.code, item]));

  return checklist.map((item) => {
    const nextItem = nextItemMap.get(item.code);
    if (nextItem) {
      return nextItem;
    }

    const previousItem = previousItemMap.get(item.code);
    if (previousItem) {
      return previousItem;
    }

    const directFiles = (evidenceIndex.directByCode[item.code] ?? []).map(
      (evidence) => evidence.fileName,
    );
    return buildFallbackItem(item, directFiles);
  });
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

function isSecurityScanChecklistItem(item) {
  return /漏洞扫描|安扫|扫描报告/u.test(item.requirement);
}

function buildScanReportReviewItem(item, scanReportAssessment) {
  return {
    code: item.code,
    status: scanReportAssessment.status,
    confidence: scanReportAssessment.confidence,
    rationale: `安扫专项结论：${scanReportAssessment.summary}`,
    basis:
      scanReportAssessment.basis.length > 0
        ? scanReportAssessment.basis
        : ["已识别安扫报告，但未提取到足够稳定的结构化依据。"],
    remediation: scanReportAssessment.remediation,
    referenceMethod: scanReportAssessment.referenceMethod,
    evidenceFiles: scanReportAssessment.evidenceFiles,
    nextAction: scanReportAssessment.qualified
      ? "保留最新安扫报告，进入后续人工终审。"
      : "请补充完整安扫材料或先完成中高危漏洞处置后再提交。",
  };
}

function normalizeReviewItems({
  checklist,
  evidenceIndex,
  reviewResult,
  visionAssessments,
  scanReportAssessment,
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

    const withVision = pickConservativeResult(baseItem, visionItem, item.mandatory);
    const scanReportItem =
      scanReportAssessment && isSecurityScanChecklistItem(item)
        ? buildScanReportReviewItem(item, scanReportAssessment)
        : null;

    return pickConservativeResult(withVision, scanReportItem, item.mandatory);
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

function resolveBusinessName(...candidates) {
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value) {
      return value;
    }
  }

  return "";
}

function normalizeUploadedFileRef(file) {
  return {
    fileName: String(file?.fileName || "").trim(),
    mimeType: String(file?.mimeType || "application/octet-stream"),
    size: Number(file?.size || 0),
    objectKey: String(file?.objectKey || "").trim(),
  };
}

function mergeUploadedFileRefs(existingFiles = [], incomingFiles = []) {
  const merged = new Map();

  for (const file of existingFiles.map(normalizeUploadedFileRef)) {
    if (!file.fileName) continue;
    merged.set(file.fileName, file);
  }

  for (const file of incomingFiles.map(normalizeUploadedFileRef)) {
    if (!file.fileName) continue;
    const existing = merged.get(file.fileName);
    if (
      existing &&
      existing.size === file.size &&
      existing.mimeType === file.mimeType
    ) {
      continue;
    }
    merged.set(file.fileName, file);
  }

  return Array.from(merged.values());
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
    const ready =
      isApiConfigured() && isDatabaseConfigured() && isObjectStorageConfigured();

    res.json({
      ok: true,
      status: ready ? "ready" : "degraded",
    });
  });

  router.post("/auth/login", async (req, res) => {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const loginWindowMs = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000);
    const loginMax = Number(process.env.LOGIN_RATE_LIMIT_MAX || 10);
    const rateIdentity = `${getClientIp(req)}:${username.toLowerCase() || "unknown"}`;
    const rateStatus = getRateLimitStatus({
      key: "login",
      identity: rateIdentity,
      windowMs: loginWindowMs,
      max: loginMax,
    });

    if (rateStatus.limited) {
      res.setHeader("Retry-After", String(rateStatus.retryAfterSeconds));
      return res.status(429).json({
        error: "登录尝试过于频繁，请稍后再试。",
      });
    }
    const session = await login(username, password);

    if (!session) {
      consumeRateLimit({
        key: "login",
        identity: rateIdentity,
        windowMs: loginWindowMs,
      });
      return res.status(401).json({
        error: "用户名或密码不正确。",
      });
    }

    resetRateLimit({
      key: "login",
      identity: rateIdentity,
    });
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

      const businessName = resolveBusinessName(
        req.body?.businessName,
        req.body?.caseName,
        reviewPayload.businessName,
        reviewPayload.caseName,
      );
      if (!businessName) {
        return res.status(400).json({ error: "请先填写业务名称。" });
      }

      const notes = String(req.body?.notes || reviewPayload.notes || "");
      const workflow = normalizeWorkflow(reviewPayload.workflow);
      const persistence = await saveReviewCase({
        caseId: req.params.caseId,
        caseName: businessName,
        notes,
        provider: reviewPayload.provider || getProviderLabel(),
        actor: req.auth.user,
        reviewData: {
          ...reviewPayload,
          businessName,
          caseName: businessName,
          notes,
          actor: req.auth.user,
          workflow,
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

  router.post("/cases/:caseId/submit-expert-review", requireAuth, async (req, res) => {
    try {
      if (req.auth.user.role !== "operator") {
        return res.status(403).json({
          error: "仅普通上传审核账号可提交专家复审。",
        });
      }

      const reviewCase = await getReviewCase(req.params.caseId, req.auth.user);
      if (!reviewCase) {
        return res.status(404).json({
          error: "未找到该案件，或当前账号无权访问。",
        });
      }

      const checklistPayload = await loadChecklist();
      const mandatoryCollection = buildMandatoryCollection(
        checklistPayload.items,
        reviewCase.items || [],
      );

      if (!mandatoryCollection.mandatoryReadyForExpert) {
        return res.status(400).json({
          error: `必须项材料未齐，暂不可提交专家复审。仍缺：${mandatoryCollection.mandatoryMissingCodes.join("、")}`,
        });
      }

      const nextPayload = {
        ...reviewCase,
        actor: req.auth.user,
        workflow: createPendingExpertWorkflow(req.auth.user),
      };

      const persistence = await saveReviewCase({
        caseId: req.params.caseId,
        caseName:
          resolveBusinessName(reviewCase.businessName, reviewCase.caseName) ||
          "未命名业务",
        notes: String(reviewCase.notes || ""),
        provider: reviewCase.provider || getProviderLabel(),
        actor: req.auth.user,
        reviewData: nextPayload,
      });

      res.json(attachPersistenceMeta(nextPayload, persistence));
    } catch (error) {
      console.error(error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "提交专家复审失败。",
      });
    }
  });

  router.post("/cases/:caseId/complete-expert-review", requireAuth, async (req, res) => {
    try {
      if (req.auth.user.role !== "expert") {
        return res.status(403).json({
          error: "仅专家人工审核账号可完成终审。",
        });
      }

      const reviewCase = await getReviewCase(req.params.caseId, req.auth.user);
      if (!reviewCase) {
        return res.status(404).json({
          error: "未找到该案件，或当前账号无权访问。",
        });
      }

      const nextPayload = {
        ...reviewCase,
        actor: req.auth.user,
        workflow: createExpertReviewedWorkflow(req.auth.user, reviewCase.workflow),
      };

      const persistence = await saveReviewCase({
        caseId: req.params.caseId,
        caseName:
          resolveBusinessName(reviewCase.businessName, reviewCase.caseName) ||
          "未命名业务",
        notes: String(reviewCase.notes || ""),
        provider: reviewCase.provider || getProviderLabel(),
        actor: req.auth.user,
        reviewData: nextPayload,
      });

      res.json(attachPersistenceMeta(nextPayload, persistence));
    } catch (error) {
      console.error(error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "标记专家终审完成失败。",
      });
    }
  });

  router.post("/analyze", requireAuth, analyzeRateLimit, upload.array("files", 20), async (req, res) => {
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
      const businessName = resolveBusinessName(req.body.businessName, req.body.caseName);
      if (!businessName) {
        return res.status(400).json({ error: "请先填写业务名称后再上传分析。" });
      }
      const requestedCaseId = String(req.body.caseId || "").trim();
      let existingCase = null;
      let caseIdForSave = requestedCaseId || undefined;
      if (requestedCaseId) {
        existingCase = await getReviewCase(requestedCaseId, req.auth.user);
        const existingBusinessName = resolveBusinessName(
          existingCase?.businessName,
          existingCase?.caseName,
        );

        if (!existingCase || (existingBusinessName && existingBusinessName !== businessName)) {
          caseIdForSave = undefined;
        }
      }
      const notes = String(req.body.notes || "");
      const incomingUploadedFiles = Array.isArray(req.body?.uploadedFiles)
        ? req.body.uploadedFiles
        : [];
      const currentBatchFiles = await collectRequestFiles(req);
      const previousUploadedFiles =
        caseIdForSave && existingCase && resolveBusinessName(existingCase.businessName, existingCase.caseName) === businessName
          ? Array.isArray(existingCase.uploadedFiles)
            ? existingCase.uploadedFiles.map(normalizeUploadedFileRef)
            : []
          : [];
      const previousUploadedFileByName = new Map(
        previousUploadedFiles.map((file) => [file.fileName, file]),
      );
      const effectiveCurrentBatchFiles = currentBatchFiles.filter((file) => {
        const previousFile = previousUploadedFileByName.get(file.originalname);
        return !(
          previousFile &&
          previousFile.size === file.size &&
          previousFile.mimeType === file.mimetype
        );
      });
      // Build uploadedFiles from both R2 refs and FormData multipart files so
      // that file metadata is always persisted even when R2 is not configured.
      const formDataFileRefs = (req.files || []).map((file) => ({
        fileName: file.originalname,
        mimeType: file.mimetype || "application/octet-stream",
        size: file.size || 0,
        objectKey: file.objectKey || "",
      }));
      const uploadedFiles = mergeUploadedFileRefs(
        previousUploadedFiles,
        incomingUploadedFiles.length > 0 ? incomingUploadedFiles : formDataFileRefs,
      );
      const currentBatchFileNames = new Set(
        effectiveCurrentBatchFiles.map((file) => file.originalname),
      );
      const files = effectiveCurrentBatchFiles;

      if (!Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: "请至少上传一个文件。" });
      }

      // Save an initial draft BEFORE AI analysis so the case and uploaded file
      // metadata are persisted even if the analysis times out or fails.
      const earlyDraft = await saveReviewCase({
        caseId: caseIdForSave,
        caseName: businessName,
        notes,
        provider: getProviderLabel(),
        actor: req.auth.user,
        reviewData: {
          provider: getProviderLabel(),
          businessName,
          caseName: businessName,
          notes,
          actor: req.auth.user,
          workflow: normalizeWorkflow(existingCase?.workflow),
          uploadedFiles,
          evidences: existingCase?.evidences ?? [],
          summary: existingCase?.summary ?? {
            recommendedDecision: "待分析",
            blockerCount: 0,
            unresolvedCount: 0,
            mandatoryPassCount: 0,
            totalMandatoryCount: 0,
            overview: "材料已上传，AI 分析进行中……",
          },
          items: existingCase?.items ?? [],
        },
      });
      caseIdForSave = earlyDraft.caseId;

      const fileMap = new Map();
      const imageCount = files.filter((file) => file.mimetype.startsWith("image/")).length;
      const inlineVisionLimit = Number(process.env.DASHSCOPE_INLINE_VISION_MAX_FILES || 6);
      const enableInlineVision =
        process.env.DASHSCOPE_ENABLE_VISION_ENRICHMENT === "true" &&
        imageCount <= Math.max(1, inlineVisionLimit);
      const evidenceConcurrency = Number(process.env.ANALYZE_FILE_CONCURRENCY || 3);
      const reusableEvidenceMap = new Map(
        Array.isArray(existingCase?.evidences)
          ? existingCase.evidences
              .filter(
                (evidence) =>
                  evidence?.fileName && !currentBatchFileNames.has(evidence.fileName),
              )
              .map((evidence) => [evidence.fileName, evidence])
          : [],
      );

      const evidences = await mapWithConcurrency(files, evidenceConcurrency, async (file) => {
        const reusableEvidence = reusableEvidenceMap.get(file.originalname);
        if (reusableEvidence) {
          fileMap.set(reusableEvidence.id, file);
          return reusableEvidence;
        }

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
          const [extractedText, visionSummary] = await Promise.all([
            ocrImage(file),
            enableInlineVision ? enrichImage(file) : Promise.resolve(""),
          ]);
          return {
            ...base,
            source: "ocr",
            extractedText,
            summary: visionSummary || "已通过百炼 OCR 提取图片文字。",
          };
        }

        const documentResult = await extractDocumentText(file);
        return {
          ...base,
          source: documentResult.source,
          extractedText: documentResult.text,
          summary: documentResult.summary,
        };
      });
      const carriedEvidences = Array.isArray(existingCase?.evidences)
        ? existingCase.evidences.filter(
            (evidence) =>
              evidence?.fileName &&
              !currentBatchFileNames.has(evidence.fileName) &&
              !evidences.some((entry) => entry.fileName === evidence.fileName),
          )
        : [];
      const combinedEvidences = [...carriedEvidences, ...evidences];

      const evidenceIndex = buildEvidenceIndex(checklist, combinedEvidences);
      const previousItems = Array.isArray(existingCase?.items) ? existingCase.items : [];
      const lockPassingItems = shouldLockPassingItems(existingCase);
      const reviewScope = lockPassingItems
        ? buildIncrementalReviewScope({
            checklist,
            previousItems,
            currentBatchEvidences: evidences,
          })
        : {
            unresolvedCodes: [],
            preservedPassCodes: [],
            reviewedCodes: checklist.map((item) => item.code),
            reviewChecklist: checklist,
          };
      const scopedChecklist = reviewScope.reviewChecklist;
      const scanReportEvidences = evidenceIndex.globalEvidences;
      const scopedScanReview = scopedChecklist.some((item) => isSecurityScanChecklistItem(item));
      const visionAssessments =
        scopedChecklist.length > 0
          ? await runMandatoryVisionRechecks({
              checklist: scopedChecklist,
              evidenceIndex,
              fileMap,
              notes,
            })
          : {};
      const scanReportImageFiles = scanReportEvidences
        .filter((evidence) => evidence.mimeType.startsWith("image/"))
        .map((evidence) => fileMap.get(evidence.id))
        .filter(Boolean);
      const scanReportAssessment =
        scanReportEvidences.length > 0 && (!lockPassingItems || scopedScanReview)
          ? await analyzeSecurityScanReport({
              businessName,
              notes,
              reportEvidences: scanReportEvidences,
              reportImageFiles: scanReportImageFiles,
            })
          : null;

      const reviewResult =
        scopedChecklist.length > 0
          ? await reviewChecklist({
              caseName: businessName,
              notes,
              checklist: scopedChecklist,
              evidenceIndex,
              visionAssessments,
              scanReportAssessment,
            })
          : { summary: {}, items: [] };

      const nextItems =
        scopedChecklist.length > 0
          ? normalizeReviewItems({
              checklist: scopedChecklist,
              evidenceIndex,
              reviewResult,
              visionAssessments,
              scanReportAssessment,
            })
          : [];
      const normalizedItems = lockPassingItems
        ? mergeReviewItems({
            checklist,
            previousItems,
            nextItems,
            evidenceIndex,
          })
        : nextItems;
      const mandatoryItems = checklist.filter((item) => item.mandatory);
      const mandatoryCollection = buildMandatoryCollection(checklist, normalizedItems);
      const incrementalScopeMessage = lockPassingItems
        ? reviewScope.reviewedCodes.length > 0
          ? `本次补件仅重审未达标项：${reviewScope.reviewedCodes.join("、")}；已达标项沿用上一版结论。`
          : "本次补件未命中新的一轮重审项，已达标项和既有结论均沿用上一版。"
        : "";
      const reviewOverview =
        reviewResult?.summary?.overview ??
        `已完成 ${normalizedItems.length} 条审查项初判，其中必须项通过 ${
          normalizedItems.filter(
            (entry) =>
              mandatoryItems.some((item) => item.code === entry.code) &&
              entry.status === "pass",
          ).length
        }/${mandatoryItems.length}。`;
      const summary = {
        ...buildRecommendedDecision(normalizedItems, mandatoryItems),
        ...mandatoryCollection,
        overview:
          `${
            reviewResult.summary?.overview ??
            `已完成 ${normalizedItems.length} 条审查项初判，其中必须项通过 ${
              normalizedItems.filter(
                (entry) =>
                  mandatoryItems.some((item) => item.code === entry.code) &&
                  entry.status === "pass",
              ).length
            }/${mandatoryItems.length}。`
          }${
            mandatoryCollection.mandatoryReadyForExpert
              ? " 必须项材料已齐套，已自动进入专家复审队列。"
              : ` 必须项材料尚未齐套，暂不自动送专家；仍缺 ${mandatoryCollection.mandatoryMissingCodes.join("、")}。`
          }`,
      };

      summary.overview = `${incrementalScopeMessage}${incrementalScopeMessage ? " " : ""}${reviewOverview}${
        mandatoryCollection.mandatoryReadyForExpert
          ? " 必须项材料已齐套，已自动进入专家复审队列。"
          : ` 必须项材料尚未齐套，暂不自动送专家；仍缺 ${mandatoryCollection.mandatoryMissingCodes.join("、")}。`
      }`;
      const preserveWorkflow = lockPassingItems && reviewScope.reviewedCodes.length === 0;

      const reviewPayload = {
        provider: getProviderLabel(),
        businessName,
        caseName: businessName,
        notes,
        actor: req.auth.user,
        workflow:
          req.auth.user.role === "operator"
            ? preserveWorkflow
              ? normalizeWorkflow(existingCase?.workflow)
              : mandatoryCollection.mandatoryReadyForExpert
                ? createPendingExpertWorkflow(req.auth.user)
                : normalizeWorkflow(undefined)
            : normalizeWorkflow(existingCase?.workflow),
        uploadedFiles,
        scanReport: scanReportAssessment,
        evidences: combinedEvidences,
        summary,
        reviewScope: {
          mode: lockPassingItems ? "incremental_unresolved" : "full_review",
          reviewedCodes: reviewScope.reviewedCodes,
          preservedPassCodes: reviewScope.preservedPassCodes,
          unresolvedCodes: reviewScope.unresolvedCodes,
        },
        items: normalizedItems,
      };

      const persistence = await saveReviewCase({
        caseId: caseIdForSave,
        caseName: businessName,
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
