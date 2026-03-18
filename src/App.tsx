import { useEffect, useState } from "react";
import checklistPayload from "../data/review_checklist.extracted.json";
import type {
  AnalysisResponse,
  AuthRole,
  AuthUser,
  CaseSummary,
  ChecklistRecord,
  ReviewItemResult,
  ReviewStatus,
  ReviewWorkflow,
  ReviewWorkflowStatus,
  SecurityScanAssessment,
  UploadedObject,
} from "./types";

const checklistItems = checklistPayload.items as ChecklistRecord[];
const sessionStorageKey = "aicheck_session_token";
type ResultView = "attention" | "matched" | "review" | "appendix";

const statusLabel: Record<ReviewStatus, string> = {
  pending: "待分析",
  pass: "符合",
  fail: "不符合",
  insufficient_evidence: "证据不足",
  manual_review_required: "待人工复核",
};

const statusTone: Record<ReviewStatus, string> = {
  pending: "pending",
  pass: "pass",
  fail: "fail",
  insufficient_evidence: "warn",
  manual_review_required: "manual",
};

const roleLabel: Record<AuthRole, string> = {
  operator: "普通上传审核",
  expert: "专家人工审核",
};

const workflowLabel: Record<ReviewWorkflowStatus, string> = {
  draft: "草稿",
  pending_expert_review: "待专家复审",
  expert_reviewed: "专家已完成复审",
};

const workflowTone: Record<ReviewWorkflowStatus, string> = {
  draft: "pending",
  pending_expert_review: "manual",
  expert_reviewed: "pass",
};

const recommendedBatch = {
  checklistItems: 6,
  images: 8,
  totalFiles: 8,
};

const caseArchiveFilterLabel = {
  all: "全部",
  pending_expert_review: "待专家",
  expert_reviewed: "已终审",
  draft: "草稿",
} as const;

const sampleCaseNames = new Set([
  "语音业务接入审核案件",
  "工作流自动送审验收",
  "未命名业务",
]);

function normalizeWorkflow(workflow?: ReviewWorkflow): ReviewWorkflow {
  return {
    status: workflow?.status ?? "draft",
    submittedToExpertAt: workflow?.submittedToExpertAt,
    submittedToExpertBy: workflow?.submittedToExpertBy,
    expertReviewedAt: workflow?.expertReviewedAt,
    expertReviewedBy: workflow?.expertReviewedBy,
  };
}

function buildPendingItem(item: ChecklistRecord): ReviewItemResult {
  return {
    code: item.code,
    status: "pending",
    confidence: 0,
    rationale: "尚未运行分析。",
    basis: ["尚未生成依据。"],
    remediation: "暂无。",
    referenceMethod: "暂无。",
    evidenceFiles: [],
    nextAction: "上传材料后点击开始分析。",
  };
}

function formatDateTime(value?: string) {
  if (!value) return "刚刚";

  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function shortCaseId(value?: string) {
  if (!value) return "--";
  return value.slice(0, 8);
}

function isSampleCaseName(name?: string) {
  const normalized = String(name || "").trim();
  return sampleCaseNames.has(normalized);
}

function isAttentionStatus(status?: ReviewStatus) {
  return (
    status === "fail" ||
    status === "insufficient_evidence" ||
    status === "manual_review_required"
  );
}

function computeSummary(items: ReviewItemResult[], overview: string) {
  const mandatoryCodes = new Set(
    checklistItems.filter((item) => item.mandatory).map((item) => item.code),
  );
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
    totalMandatoryCount: mandatoryCodes.size,
    overview,
  };
}

async function readApiPayload(response: Response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  const compact = text.trim();

  if (!compact) {
    return {};
  }

  if (response.status === 504 || compact.includes("Task timed out after 300 seconds")) {
      return {
        error:
        "分析超时：当前批次材料较多。建议每次先传 5 到 8 个文件，文件较多时分批提交，优先上传关键截图。",
    };
  }

  return {
    error: compact.slice(0, 240),
  };
}

function hasValidCodeBoundary(remainder: string) {
  if (!remainder) return true;

  const firstChar = remainder[0];
  return firstChar !== "." && !/\d/u.test(firstChar);
}

function inferChecklistCodeFromName(fileName: string) {
  const baseName = fileName.replace(/\.[^.]+$/, "").trim();
  const sortedCodes = checklistItems
    .map((item) => item.code)
    .sort((left, right) => right.length - left.length);

  for (const code of sortedCodes) {
    if (!baseName.startsWith(code)) {
      continue;
    }

    const remainder = baseName.slice(code.length);
    if (hasValidCodeBoundary(remainder)) {
      return code;
    }
  }

  return "";
}

function buildBatchRecommendation(files: File[]) {
  if (files.length === 0) return null;

  const imageCount = files.filter((file) => file.type.startsWith("image/")).length;
  const distinctCodes = new Set(
    files.map((file) => inferChecklistCodeFromName(file.name)).filter(Boolean),
  ).size;

  const exceedsRecommended =
    distinctCodes > recommendedBatch.checklistItems ||
    imageCount > recommendedBatch.images ||
    files.length > recommendedBatch.totalFiles;

  if (!exceedsRecommended) {
    return null;
  }

  const suggestedBatches = Math.max(
    2,
    Math.ceil(
      Math.max(
        distinctCodes / recommendedBatch.checklistItems,
        imageCount / recommendedBatch.images,
        files.length / recommendedBatch.totalFiles,
      ),
    ),
  );

  return {
    imageCount,
    distinctCodes,
    totalFiles: files.length,
    suggestedBatches,
  };
}

function App() {
  const [authToken, setAuthToken] = useState(
    () => window.localStorage.getItem(sessionStorageKey) ?? "",
  );
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(Boolean(authToken));
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [loginForm, setLoginForm] = useState({ username: "", password: "" });

  const [businessName, setBusinessName] = useState("");
  const [notes, setNotes] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSavingReview, setIsSavingReview] = useState(false);
  const [isSubmittingToExpert, setIsSubmittingToExpert] = useState(false);
  const [isCompletingExpertReview, setIsCompletingExpertReview] = useState(false);
  const [error, setError] = useState("");
  const [resultView, setResultView] = useState<ResultView>("appendix");
  const [checklistQuery, setChecklistQuery] = useState("");
  const [showMechanism, setShowMechanism] = useState(false);
  const [showEvidencePanel, setShowEvidencePanel] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [manualOverrides, setManualOverrides] = useState<
    Record<string, ReviewItemResult>
  >({});
  const [selectedCode, setSelectedCode] = useState<string>(
    checklistItems[0]?.code ?? "",
  );
  const [caseHistory, setCaseHistory] = useState<CaseSummary[]>([]);
  const [casesLoading, setCasesLoading] = useState(false);
  const [casesError, setCasesError] = useState("");
  const [caseHistoryQuery, setCaseHistoryQuery] = useState("");
  const [caseHistoryFilter, setCaseHistoryFilter] =
    useState<keyof typeof caseArchiveFilterLabel>("all");
  const [showSampleCases, setShowSampleCases] = useState(false);
  const batchRecommendation = buildBatchRecommendation(files);
  const trimmedBusinessName = businessName.trim();

  const canExpertReview = authUser?.role === "expert";
  const currentWorkflow = normalizeWorkflow(analysis?.workflow);
  const operatorCanSubmitToExpert =
    authUser?.role === "operator" &&
    Boolean(analysis?.caseId) &&
    currentWorkflow.status !== "pending_expert_review";
  const expertCanCompleteReview =
    canExpertReview && Boolean(analysis?.caseId) && currentWorkflow.status !== "expert_reviewed";

  useEffect(() => {
    if (!authToken) {
      setAuthLoading(false);
      setAuthUser(null);
      return;
    }

    let cancelled = false;

    async function loadSession() {
      setAuthLoading(true);
      try {
        const response = await fetch("/api/auth/me", {
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        });

        if (!response.ok) {
          throw new Error("登录状态已失效，请重新登录。");
        }

        const payload = (await response.json()) as { user: AuthUser };
        if (!cancelled) {
          setAuthUser(payload.user);
          setAuthError("");
        }
      } catch (sessionError) {
        if (!cancelled) {
          setAuthUser(null);
          setAuthToken("");
          window.localStorage.removeItem(sessionStorageKey);
          setAuthError(
            sessionError instanceof Error
              ? sessionError.message
              : "登录状态已失效，请重新登录。",
          );
        }
      } finally {
        if (!cancelled) {
          setAuthLoading(false);
        }
      }
    }

    loadSession();

    return () => {
      cancelled = true;
    };
  }, [authToken]);

  useEffect(() => {
    if (!authToken || !authUser) {
      setCaseHistory([]);
      setCasesError("");
      return;
    }

    let cancelled = false;

    async function loadCases() {
      setCasesLoading(true);
      setCasesError("");

      try {
        const response = await fetch("/api/cases", {
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        });
        const payload = (await response.json()) as
          | { cases: CaseSummary[] }
          | { error?: string };

        if (!response.ok) {
          throw new Error(
            "error" in payload && payload.error
              ? payload.error
              : "读取案件列表失败。",
          );
        }

        if (!cancelled) {
          setCaseHistory(payload.cases);
        }
      } catch (loadError) {
        if (!cancelled) {
          setCasesError(
            loadError instanceof Error ? loadError.message : "读取案件列表失败。",
          );
        }
      } finally {
        if (!cancelled) {
          setCasesLoading(false);
        }
      }
    }

    loadCases();

    return () => {
      cancelled = true;
    };
  }, [authToken, authUser]);

  const mergedItems = checklistItems.map((item) => {
    const fromAnalysis = analysis?.items.find((entry) => entry.code === item.code);
    const fromManual = manualOverrides[item.code];

    return (
      fromManual ??
      fromAnalysis ?? {
        code: item.code,
        status: "pending" as ReviewStatus,
        confidence: 0,
        rationale: "尚未运行分析。",
        basis: ["尚未生成依据。"],
        remediation: "暂无。",
        referenceMethod: "暂无。",
        evidenceFiles: [],
        nextAction: "上传材料后点击开始分析。",
      }
    );
  });
  const resultMap = new Map(mergedItems.map((item) => [item.code, item]));
  const linkedCodeSet = new Set(
    (analysis?.evidences ?? []).flatMap((entry) => entry.linkedCodes ?? []),
  );
  const checklistKeyword = checklistQuery.trim().toLowerCase();

  function hasEvidenceMatch(code: string) {
    const result = resultMap.get(code);
    return linkedCodeSet.has(code) || (result?.evidenceFiles?.length ?? 0) > 0;
  }

  function isFocusItem(code: string) {
    const result = resultMap.get(code);
    return hasEvidenceMatch(code) || isAttentionStatus(result?.status);
  }

  const attentionItems = checklistItems.filter((item) => {
    const result = resultMap.get(item.code);
    return isAttentionStatus(result?.status) || (hasEvidenceMatch(item.code) && result?.status === "pending");
  });
  const matchedItems = checklistItems.filter((item) => hasEvidenceMatch(item.code));
  const mandatoryMatchedItems = checklistItems.filter(
    (item) => item.mandatory && hasEvidenceMatch(item.code),
  );
  const expertReviewItems =
    attentionItems.length > 0
      ? attentionItems
      : mandatoryMatchedItems.length > 0
        ? mandatoryMatchedItems
        : matchedItems.length > 0
          ? matchedItems
          : checklistItems;
  const baseResultItems =
    resultView === "attention"
      ? attentionItems
      : resultView === "matched"
        ? matchedItems
        : resultView === "review"
          ? expertReviewItems
          : checklistItems;
  const filteredItems = baseResultItems.filter((item) => {
    if (!checklistKeyword) return true;
    const searchTarget = [item.code, item.requirement, item.category].join(" ").toLowerCase();
    return searchTarget.includes(checklistKeyword);
  });

  const selectedChecklist = analysis
    ? checklistItems.find((item) => item.code === selectedCode)
    : undefined;
  const selectedResult = analysis ? resultMap.get(selectedCode) ?? mergedItems[0] : undefined;

  const statBlockers = mergedItems.filter(
    (item, index) =>
      checklistItems[index]?.mandatory &&
      (item.status === "fail" || item.status === "insufficient_evidence"),
  ).length;
  const statPass = mergedItems.filter((item) => item.status === "pass").length;
  const statManual = mergedItems.filter(
    (item) =>
      item.status === "manual_review_required" ||
      item.status === "insufficient_evidence",
  ).length;
  const focusItemCount = checklistItems.filter((item) => isFocusItem(item.code)).length;
  const scopedPendingCount = attentionItems.length;
  const archiveKeyword = caseHistoryQuery.trim().toLowerCase();
  const hiddenSampleCaseCount = caseHistory.filter((entry) =>
    isSampleCaseName(entry.businessName ?? entry.caseName),
  ).length;
  const filteredCaseHistory = caseHistory.filter((entry) => {
    if (!showSampleCases && isSampleCaseName(entry.businessName ?? entry.caseName)) {
      return false;
    }

    const workflowMatches =
      caseHistoryFilter === "all" || entry.workflow.status === caseHistoryFilter;
    if (!workflowMatches) {
      return false;
    }

    if (!archiveKeyword) {
      return true;
    }

    const searchTarget = [
      entry.businessName,
      entry.caseName,
      entry.caseId,
      entry.createdBy.displayName,
      entry.createdBy.username,
      entry.recommendedDecision,
    ]
      .join(" ")
      .toLowerCase();

    return searchTarget.includes(archiveKeyword);
  });
  const inProgressCases = filteredCaseHistory.filter(
    (entry) => entry.workflow.status !== "expert_reviewed",
  );
  const reviewedCases = filteredCaseHistory.filter(
    (entry) => entry.workflow.status === "expert_reviewed",
  );
  const archiveSummary = {
    total: caseHistory.length,
    pending: caseHistory.filter((entry) => entry.workflow.status === "pending_expert_review")
      .length,
    reviewed: caseHistory.filter((entry) => entry.workflow.status === "expert_reviewed").length,
  };
  const archiveViewSummary = {
    visible: filteredCaseHistory.length,
    inProgress: inProgressCases.length,
    reviewed: reviewedCases.length,
  };
  const scanReport = analysis?.scanReport as SecurityScanAssessment | undefined;
  const expertQueueCases = filteredCaseHistory.filter(
    (entry) => entry.workflow.status === "pending_expert_review",
  );
  const reviewPanelTitle = canExpertReview ? "专家复核重点" : "本次审核结果";
  const reviewTabOptions: Array<[ResultView, string]> = canExpertReview
    ? [
        ["review", "待复核"],
        ["matched", "已命中"],
        ["appendix", "完整附录"],
      ]
    : [
        ["attention", "待处理"],
        ["matched", "已命中"],
        ["appendix", "完整附录"],
      ];
  const currentBusinessName = analysis?.businessName || trimmedBusinessName || "未选择业务";
  const nextStepText = canExpertReview
    ? !analysis
      ? "请先从左侧选择一条待专家复审案件。"
      : currentWorkflow.status === "expert_reviewed"
        ? "当前案件已完成终审，可回看问题项或导出结论。"
        : "请优先复核待处理项和必须项，确认后完成专家终审。"
    : !analysis
      ? "请先填写业务名称并上传本批材料。"
      : currentWorkflow.status === "pending_expert_review"
        ? "当前案件已自动进入专家复审队列，等待专家确认。"
        : scopedPendingCount > 0
          ? "请优先补齐问题项或证据不足项，再提交专家复审。"
          : "本次结果已生成，可直接提交专家复审。";
  const viewDescription = canExpertReview
    ? "默认只展示当前案件最需要专家处理的条目；完整清单作为附录按需查看。"
    : "默认只展示当前业务的待处理项；其余命中项和完整清单按需查看。";

  useEffect(() => {
    if (analysis?.caseId) {
      setResultView(
        canExpertReview
          ? "review"
          : scopedPendingCount > 0
            ? "attention"
            : matchedItems.length > 0
              ? "matched"
              : "appendix",
      );
      setChecklistQuery("");
      setShowEvidencePanel(false);
    } else {
      setResultView(canExpertReview ? "review" : "appendix");
    }
  }, [analysis?.caseId, canExpertReview, matchedItems.length, scopedPendingCount]);

  useEffect(() => {
    if (!filteredItems.some((item) => item.code === selectedCode) && filteredItems[0]?.code) {
      setSelectedCode(filteredItems[0].code);
    }
  }, [filteredItems, selectedCode]);

  useEffect(() => {
    if (canExpertReview && caseHistoryFilter === "all") {
      setCaseHistoryFilter("pending_expert_review");
    }
  }, [canExpertReview, caseHistoryFilter]);

  async function refreshCases() {
    if (!authToken || !authUser) return;

    try {
      const response = await fetch("/api/cases", {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      const payload = (await response.json()) as { cases?: CaseSummary[] };
      if (response.ok && Array.isArray(payload.cases)) {
        setCaseHistory(payload.cases);
      }
    } catch {
      // Keep the current list if refresh fails.
    }
  }

  async function uploadFilesToObjectStorage(): Promise<UploadedObject[] | null> {
    if (files.length === 0) {
      return [];
    }

    const response = await fetch("/api/uploads/sign", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        caseId: analysis?.caseId || "draft",
        files: files.map((file) => ({
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
        })),
      }),
    });

    const payload = await readApiPayload(response);
    if (!response.ok) {
      const message = String(payload?.error || "");
      if (message.includes("R2")) {
        return null;
      }

      throw new Error(message || "生成上传地址失败。");
    }

    const uploads = Array.isArray(payload.uploads) ? payload.uploads : [];
    await Promise.all(
      uploads.map(async (target, index) => {
        const file = files[index];
        const uploadResponse = await fetch(target.uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": target.mimeType || file.type || "application/octet-stream",
          },
          body: file,
        });

        if (!uploadResponse.ok) {
          throw new Error(`文件上传失败：${file.name}`);
        }
      }),
    );

    return uploads.map((target) => ({
      fileName: target.fileName,
      mimeType: target.mimeType,
      size: target.size,
      objectKey: target.objectKey,
    }));
  }

  function buildReviewSnapshot(overrides: Record<string, ReviewItemResult>) {
    if (!analysis || !authUser) return null;

    const nextItems = checklistItems.map((item) => {
      return (
        overrides[item.code] ??
        analysis.items.find((entry) => entry.code === item.code) ??
        buildPendingItem(item)
      );
    });

    const nextOverview =
      Object.keys(overrides).length > 0
        ? "当前案件已包含专家人工覆盖，请优先以最新复核结果为准。"
        : analysis.summary.overview;

    return {
      ...analysis,
      businessName: trimmedBusinessName,
      caseName: trimmedBusinessName,
      notes,
      actor: authUser,
      workflow: currentWorkflow,
      items: nextItems,
      summary: computeSummary(nextItems, nextOverview),
    };
  }

  async function persistReviewSnapshot(overrides: Record<string, ReviewItemResult>) {
    if (!analysis?.caseId || !authUser) return;

    const snapshot = buildReviewSnapshot(overrides);
    if (!snapshot) return;

    setIsSavingReview(true);
    try {
      const response = await fetch(`/api/cases/${analysis.caseId}/review`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          businessName: trimmedBusinessName,
          notes,
          review: snapshot,
        }),
      });

      const payload = await readApiPayload(response);
      if (!response.ok) {
        throw new Error(payload.error ?? "保存人工复核结果失败。");
      }

      setAnalysis({
        ...snapshot,
        caseId: payload.caseId ?? analysis.caseId,
        createdAt: payload.createdAt ?? analysis.createdAt,
        updatedAt: payload.updatedAt ?? analysis.updatedAt,
      });
      setManualOverrides({});
      await refreshCases();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "保存人工复核结果失败。",
      );
    } finally {
      setIsSavingReview(false);
    }
  }

  async function loadCase(caseId: string) {
    setError("");

    try {
      const response = await fetch(`/api/cases/${caseId}`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      const payload = await readApiPayload(response);
      if (!response.ok) {
        throw new Error(payload.error ?? "读取案件详情失败。");
      }

      const nextAnalysis = payload as AnalysisResponse;
      setAnalysis(nextAnalysis);
      setManualOverrides({});
      setBusinessName(nextAnalysis.businessName ?? nextAnalysis.caseName ?? "");
      setNotes(nextAnalysis.notes ?? "");
      setFiles([]);
      if (nextAnalysis.items?.[0]?.code) {
        setSelectedCode(nextAnalysis.items[0].code);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "读取案件详情失败。");
    }
  }

  useEffect(() => {
    if (!canExpertReview || analysis?.caseId || casesLoading || caseHistory.length === 0) {
      return;
    }

    const firstPendingCase = caseHistory.find((entry) => {
      if (!showSampleCases && isSampleCaseName(entry.businessName ?? entry.caseName)) {
        return false;
      }

      return entry.workflow.status === "pending_expert_review";
    });

    if (firstPendingCase) {
      loadCase(firstPendingCase.caseId);
    }
  }, [analysis?.caseId, canExpertReview, caseHistory, casesLoading, showSampleCases]);

  async function submitToExpertReview() {
    if (!analysis?.caseId || authUser?.role !== "operator") return;

    setError("");
    setIsSubmittingToExpert(true);
    try {
      const response = await fetch(`/api/cases/${analysis.caseId}/submit-expert-review`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      const payload = await readApiPayload(response);
      if (!response.ok) {
        throw new Error(payload.error ?? "提交专家复审失败。");
      }

      const nextAnalysis = payload as AnalysisResponse;
      setAnalysis(nextAnalysis);
      setBusinessName(nextAnalysis.businessName ?? nextAnalysis.caseName ?? "");
      setNotes(nextAnalysis.notes ?? "");
      await refreshCases();
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "提交专家复审失败。",
      );
    } finally {
      setIsSubmittingToExpert(false);
    }
  }

  async function completeExpertReview() {
    if (!analysis?.caseId || authUser?.role !== "expert") return;

    setError("");
    setIsCompletingExpertReview(true);
    try {
      const response = await fetch(`/api/cases/${analysis.caseId}/complete-expert-review`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      const payload = await readApiPayload(response);
      if (!response.ok) {
        throw new Error(payload.error ?? "标记专家终审完成失败。");
      }

      const nextAnalysis = payload as AnalysisResponse;
      setAnalysis(nextAnalysis);
      setBusinessName(nextAnalysis.businessName ?? nextAnalysis.caseName ?? "");
      setNotes(nextAnalysis.notes ?? "");
      await refreshCases();
    } catch (completeError) {
      setError(
        completeError instanceof Error ? completeError.message : "标记专家终审完成失败。",
      );
    } finally {
      setIsCompletingExpertReview(false);
    }
  }

  async function handleLogin() {
    setAuthError("");
    setIsLoggingIn(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(loginForm),
      });

      const payload = await readApiPayload(response);
      if (!response.ok) {
        throw new Error(payload.error ?? "登录失败，请检查账号信息。");
      }

      window.localStorage.setItem(sessionStorageKey, payload.token);
      setAuthToken(payload.token);
      setAuthUser(payload.user);
      setLoginForm({ username: "", password: "" });
    } catch (loginError) {
      setAuthError(
        loginError instanceof Error ? loginError.message : "登录失败，请检查账号信息。",
      );
    } finally {
      setIsLoggingIn(false);
    }
  }

  async function handleLogout() {
    try {
      if (authToken) {
        await fetch("/api/auth/logout", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        });
      }
    } finally {
      setAuthToken("");
      setAuthUser(null);
      setAnalysis(null);
      setManualOverrides({});
      setCaseHistory([]);
      setFiles([]);
      setCasesError("");
      window.localStorage.removeItem(sessionStorageKey);
    }
  }

  async function handleSubmit() {
    setError("");

    if (!trimmedBusinessName) {
      setError("请先填写业务名称，再上传材料并发起分析。");
      return;
    }

    setIsSubmitting(true);

    try {
      let response;
      const uploadedFiles = await uploadFilesToObjectStorage();

      if (uploadedFiles) {
        response = await fetch("/api/analyze", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            businessName: trimmedBusinessName,
            notes,
            caseId: analysis?.caseId,
            uploadedFiles,
          }),
        });
      } else {
        const formData = new FormData();
        formData.append("businessName", trimmedBusinessName);
        formData.append("notes", notes);
        if (analysis?.caseId) {
          formData.append("caseId", analysis.caseId);
        }
        files.forEach((file) => formData.append("files", file));

        response = await fetch("/api/analyze", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
          body: formData,
        });
      }

      const payload = await readApiPayload(response);
      if (!response.ok) {
        throw new Error(payload.error ?? "分析失败，请稍后重试。");
      }

      const nextAnalysis = payload as AnalysisResponse;
      setAnalysis(nextAnalysis);
      setManualOverrides({});
      setBusinessName(nextAnalysis.businessName ?? nextAnalysis.caseName ?? "");
      setNotes(nextAnalysis.notes ?? notes);
      setFiles([]);
      if (nextAnalysis.items?.[0]?.code) {
        setSelectedCode(nextAnalysis.items[0].code);
      }
      await refreshCases();
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "分析失败，请稍后重试。",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  function updateFiles(nextFiles: FileList | null) {
    if (!nextFiles) return;
    setFiles(Array.from(nextFiles));
  }

  async function applyOverride(status: ReviewStatus) {
    if (!canExpertReview || !selectedChecklist || !selectedResult) return;

    const nextOverrides = {
      ...manualOverrides,
      [selectedChecklist.code]: {
        ...selectedResult,
        status,
        confidence: Math.max(selectedResult.confidence, 95),
        rationale:
          selectedResult.rationale +
          "\n\n[人工覆盖] 专家审核员已在内部工具中手动调整该项结论。",
        nextAction: "人工覆盖已完成，请在提交前复核证据链。",
      },
    };

    setManualOverrides(nextOverrides);
    await persistReviewSnapshot(nextOverrides);
  }

  function exportSummary() {
    if (!canExpertReview) return;

    const lines = [
      `# ${trimmedBusinessName || "未命名业务"} - Review Export`,
      "",
      `- 总项数: ${checklistItems.length}`,
      `- 已通过: ${statPass}`,
      `- 阻断项: ${statBlockers}`,
      `- 待人工处理: ${statManual}`,
      `- 当前审核角色: ${authUser ? roleLabel[authUser.role] : "未登录"}`,
      "",
      "## 汇总意见",
      analysis?.summary.overview ?? "尚未生成。",
      "",
      "## 逐项结果",
    ];

    checklistItems.forEach((item) => {
      const result = mergedItems.find((entry) => entry.code === item.code);
      lines.push(
        `- ${item.code} ${item.requirement}`,
        `  状态: ${statusLabel[result?.status ?? "pending"]}`,
        `  置信度: ${result?.confidence ?? 0}`,
        `  证据: ${(result?.evidenceFiles ?? []).join(", ") || "无"}`,
        `  说明: ${result?.rationale ?? "无"}`,
      );
    });

    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "voice-security-review.md";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  if (authLoading && !authUser) {
    return (
      <main className="shell login-shell">
        <section className="login-card">
          <p className="eyebrow">Session Check</p>
          <h1>语音业务对接入网技术审核台</h1>
          <p className="hero-text">正在校验登录状态，请稍候。</p>
        </section>
      </main>
    );
  }

  if (!authUser) {
    return (
      <main className="shell login-shell">
        <section className="login-card">
          <p className="eyebrow">Internal Access</p>
          <h1>语音业务对接入网技术审核台</h1>
          <p className="hero-text">
            MVP 仅保留两类账号：普通上传审核账号负责材料提交与 AI 初判，专家人工审核账号负责复核、人工覆盖和导出结论。
          </p>

          <div className="login-role-grid">
            <article className="summary-card">
              <p className="section-kicker">普通上传审核</p>
              <p>上传命名规范材料、触发 AI 分析、查看初审结果。</p>
            </article>
            <article className="summary-card">
              <p className="section-kicker">专家人工审核</p>
              <p>在 AI 初判基础上人工覆盖、形成最终审核意见并导出。</p>
            </article>
          </div>

          <div className="intake-grid">
            <label className="field">
              <span>用户名</span>
              <input
                value={loginForm.username}
                onChange={(event) =>
                  setLoginForm((current) => ({
                    ...current,
                    username: event.target.value,
                  }))
                }
              />
            </label>

            <label className="field">
              <span>密码</span>
              <div className="password-field">
                <input
                  type={showLoginPassword ? "text" : "password"}
                  value={loginForm.password}
                  onChange={(event) =>
                    setLoginForm((current) => ({
                      ...current,
                      password: event.target.value,
                    }))
                  }
                />
                <button
                  className="password-toggle"
                  type="button"
                  aria-label={showLoginPassword ? "隐藏密码" : "显示密码"}
                  onClick={() => setShowLoginPassword((current) => !current)}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    aria-hidden="true"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z" />
                    <circle cx="12" cy="12" r="3" />
                    {showLoginPassword ? null : <path d="M4 20 20 4" />}
                  </svg>
                </button>
              </div>
            </label>
          </div>

          <div className="action-row login-actions">
            <button
              className="primary-button"
              type="button"
              onClick={handleLogin}
              disabled={isLoggingIn}
            >
              {isLoggingIn ? "登录中..." : "登录进入"}
            </button>
          </div>

          {authError ? <p className="error-banner">{authError}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Internal MVP</p>
          <h2 className="topbar-title">语音业务对接入网技术审核台</h2>
        </div>
        <div className="topbar-actions">
          <span className={`status-tag ${canExpertReview ? "manual" : "pending"}`}>
            {roleLabel[authUser.role]}
          </span>
          <span className="soft-badge">{authUser.displayName}</span>
          <button className="ghost-button" type="button" onClick={handleLogout}>
            退出登录
          </button>
        </div>
      </section>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Voice Access Review</p>
          <h1>语音业务对接入网技术审核台</h1>
          <p className="hero-text">
            当前版本只保留最核心的闭环：登录分权、上传命名规范材料、调用百炼 API 完成初判、由专家账号人工复核并导出结果。
          </p>
        </div>

        <div className="hero-rail">
          <div className="hero-card">
            <span>必须项</span>
            <strong>{checklistPayload.summary.mandatory_items}</strong>
          </div>
          <div className="hero-card">
            <span>已通过</span>
            <strong>{statPass}</strong>
          </div>
          <div className="hero-card">
            <span>阻断项</span>
            <strong>{statBlockers}</strong>
          </div>
          <div className="hero-card">
            <span>待处理</span>
            <strong>{statManual}</strong>
          </div>
        </div>
      </section>

      <section className="mechanism panel">
        <div className="panel-head mechanism-head">
          <div>
            <p className="section-kicker">Review Flow</p>
            <h3>审查工作机制</h3>
          </div>
          <div className="mechanism-actions">
            <span className="soft-badge">AI 初判 + 专家终审</span>
            <button
              className="ghost-button"
              type="button"
              onClick={() => setShowMechanism((current) => !current)}
            >
              {showMechanism ? "收起流程详情" : "查看流程详情"}
            </button>
          </div>
        </div>
        <p className="mechanism-summary">
          默认流程：材料归档 → 证据抽取 → 必须项复判 → 专家终审。日常使用时可直接聚焦下方上传与审查结果。
        </p>
        {showMechanism ? (
          <div className="mechanism-grid">
            <article className="mechanism-step">
              <span className="mechanism-index">01</span>
              <h4>材料归档</h4>
              <p>
                按审查项编号上传截图和文档，系统优先依据文件名前缀完成自动归档，
                <code>安扫报告</code> 作为全局证据参与比对。
              </p>
            </article>

            <article className="mechanism-step">
              <span className="mechanism-index">02</span>
              <h4>证据抽取</h4>
              <p>
                图片先做 OCR，文档提取正文内容，保留命中的文件名、摘要和原始文本，
                作为逐条审查的基础证据。
              </p>
            </article>

            <article className="mechanism-step">
              <span className="mechanism-index">03</span>
              <h4>必须项复判</h4>
              <p>
                必须项在命中截图时追加视觉模型复判。若 OCR 与视觉结论冲突，
                系统默认保留更保守的结果，证据不足不直接判通过。
              </p>
            </article>

            <article className="mechanism-step">
              <span className="mechanism-index">04</span>
              <h4>专家终审</h4>
              <p>
                专家账号重点复核阻断项和证据不足项，可人工覆盖结论，
                并输出带依据、整改项和参考做法的审核结果。
              </p>
            </article>
          </div>
        ) : null}
      </section>

      {canExpertReview ? (
        <section className="review-control-panel panel">
          <div className="panel-head">
            <div>
              <p className="section-kicker">Expert Desk</p>
              <h3>专家复审工作台</h3>
            </div>
            <button
              className="ghost-button"
              type="button"
              onClick={exportSummary}
              disabled={!analysis}
            >
              导出当前结论
            </button>
          </div>

          <div className="result-rail">
            <article className="result-card">
              <span>待复审案件</span>
              <strong>{expertQueueCases.length}</strong>
              <p>左侧默认只显示待专家处理的业务。</p>
            </article>
            <article className="result-card">
              <span>当前业务</span>
              <strong>{currentBusinessName}</strong>
              <p>{analysis ? analysis.summary.recommendedDecision : "先从左侧选择一条待复审案件。"}</p>
            </article>
            <article className="result-card">
              <span>下一步</span>
              <strong>{currentWorkflow.status === "expert_reviewed" ? "已终审" : "待复核"}</strong>
              <p>{nextStepText}</p>
            </article>
          </div>

          <div className="action-row">
            <button
              className="ghost-button"
              type="button"
              onClick={completeExpertReview}
              disabled={!analysis?.caseId || !expertCanCompleteReview || isCompletingExpertReview}
            >
              {currentWorkflow.status === "expert_reviewed"
                ? "专家终审已完成"
                : isCompletingExpertReview
                  ? "终审提交中..."
                  : "标记专家终审完成"}
            </button>
            <p className="hint">
              专家默认只看待复核项、问题项和必须项；完整清单仅在需要追溯时查看。
            </p>
          </div>

          {analysis?.caseId ? (
            <p className="hint sync-note">
              当前案件：{analysis.businessName} · {analysis.caseId} · 最后更新于{" "}
              {formatDateTime(analysis.updatedAt)}。
              {isSavingReview ? " 正在同步人工复核结果..." : ""}
            </p>
          ) : (
            <p className="hint sync-note">请先从左侧“审核中项目”选择一条待专家复审案件。</p>
          )}

          {error ? <p className="error-banner">{error}</p> : null}
        </section>
      ) : (
        <section className="intake-panel">
          <div className="intake-head">
            <div>
              <p className="section-kicker">Case Intake</p>
              <h2>上传材料并发起预审</h2>
            </div>
          </div>

          <div className="intake-grid">
            <label className="field">
              <span>业务名称</span>
              <input
                value={businessName}
                placeholder="请填写业务名称，如：语音网关接入"
                onChange={(event) => setBusinessName(event.target.value)}
              />
            </label>

            <p className="uploader-note field-wide">
              请先填写业务名称。后续上传分析、案件保存、专家复审与导出结果都会基于该业务名称流转。
            </p>

            <label className="field field-wide">
              <span>审核备注 / 补充要求</span>
              <textarea
                rows={4}
                value={notes}
                placeholder="优先关注黄底必须项；若证据不足，宁可判为待人工复核。"
                onChange={(event) => setNotes(event.target.value)}
              />
            </label>

            <label className="uploader field-wide">
              <input
                type="file"
                multiple
                accept=".png,.jpg,.jpeg,.webp,.pdf,.docx,.txt,.md,.json"
                onChange={(event) => updateFiles(event.target.files)}
              />
              <strong>拖拽或点击上传材料</strong>
              <span>
                支持图片、PDF、DOCX、TXT、MD、JSON，系统会优先按审查项编号前缀自动归档。
              </span>
            </label>
            <div className="uploader-note field-wide">
              <ul className="upload-rules">
                <li>建议每次先传 5 到 8 个文件，文件较多时分批上传。</li>
                <li>文件名建议以审查项编号开头，如 <code>2.8.1.1-1.png</code>。</li>
                <li>单个文件不超过 15MB，不支持 ZIP。</li>
                <li>关键证据优先传独立图片，Word / PDF 作为补充材料。</li>
              </ul>
            </div>
          </div>

          {files.length > 0 ? (
            <div className="file-strip">
              {files.map((file) => (
                <article className="file-pill" key={file.name + file.size}>
                  <strong>{file.name}</strong>
                  <span>{Math.max(file.size / 1024, 1).toFixed(1)} KB</span>
                </article>
              ))}
            </div>
          ) : null}

          {batchRecommendation ? (
            <p className="batch-warning">
              当前批次共 {batchRecommendation.totalFiles} 个文件，其中图片{" "}
              {batchRecommendation.imageCount} 张，覆盖约 {batchRecommendation.distinctCodes || "多"} 个审查项。
              为降低超时风险，建议拆成 {batchRecommendation.suggestedBatches} 批提交，每批先控制在 5 到 8 个文件。
            </p>
          ) : null}

          <div className="action-row">
            <button
              className="primary-button"
              type="button"
              onClick={handleSubmit}
              disabled={isSubmitting || !trimmedBusinessName}
            >
              {isSubmitting ? "分析中..." : "开始分析"}
            </button>
            {analysis?.caseId ? (
              <button
                className="ghost-button"
                type="button"
                onClick={submitToExpertReview}
                disabled={!operatorCanSubmitToExpert || isSubmittingToExpert}
              >
                {currentWorkflow.status === "expert_reviewed"
                  ? isSubmittingToExpert
                    ? "重新提交中..."
                    : "重新提交专家复审"
                  : currentWorkflow.status === "pending_expert_review"
                    ? "已进入专家复审队列"
                    : isSubmittingToExpert
                      ? "提交中..."
                      : "提交专家复审"}
              </button>
            ) : null}
            <p className="hint">
              默认调用链路：<code>qwen-vl-ocr</code> -&gt; <code>qwen-flash</code>。当前视觉增强复判使用 <code>qwen3-vl-plus</code>。
            </p>
          </div>

          {analysis?.caseId ? (
            <div className="result-rail compact">
              <article className="result-card">
                <span>当前业务</span>
                <strong>{analysis.businessName}</strong>
                <p>{analysis.summary.recommendedDecision}</p>
              </article>
              <article className="result-card">
                <span>待处理项</span>
                <strong>{scopedPendingCount}</strong>
                <p>{nextStepText}</p>
              </article>
              <article className="result-card">
                <span>当前流程</span>
                <strong>{workflowLabel[currentWorkflow.status]}</strong>
                <p>{currentWorkflow.submittedToExpertAt ? `已送审 ${formatDateTime(currentWorkflow.submittedToExpertAt)}` : "尚未提交专家复审"}</p>
              </article>
            </div>
          ) : null}

          {analysis?.caseId ? (
            <p className="hint sync-note">
              当前案件已持久化保存：{analysis.caseId}，最后更新于 {formatDateTime(analysis.updatedAt)}。
              {isSavingReview ? " 正在同步人工复核结果..." : ""}
            </p>
          ) : null}

          {!trimmedBusinessName ? (
            <p className="hint sync-note">请先填写业务名称，再发起上传分析。</p>
          ) : null}

          {error ? <p className="error-banner">{error}</p> : null}
        </section>
      )}

      <section className="workspace">
        <aside className="navigator panel">
          <div className="panel-head">
            <div>
              <p className="section-kicker">Archive</p>
              <h3>历史案件</h3>
            </div>
          </div>

          <div className="summary-card">
            <p className="section-kicker">Case Archive</p>
            <div className="archive-toolbar">
              <input
                className="archive-search"
                value={caseHistoryQuery}
                placeholder="搜索业务名称、提交人、结论或案件 ID"
                onChange={(event) => setCaseHistoryQuery(event.target.value)}
              />
            </div>
            <div className="archive-stats">
              <article className="archive-stat">
                <span>全部</span>
                <strong>{archiveSummary.total}</strong>
              </article>
              <article className="archive-stat">
                <span>待专家</span>
                <strong>{archiveSummary.pending}</strong>
              </article>
              <article className="archive-stat">
                <span>已终审</span>
                <strong>{archiveSummary.reviewed}</strong>
              </article>
            </div>
            <p className="archive-meta">
              已加载 {archiveSummary.total} 条案件，当前命中 {archiveViewSummary.visible} 条。
              审核中 {archiveViewSummary.inProgress} 条，已审核 {archiveViewSummary.reviewed} 条。
            </p>
            {hiddenSampleCaseCount > 0 ? (
              <div className="archive-toggle-row">
                <p className="hint">
                  默认已隐藏 {hiddenSampleCaseCount} 条测试/验收案件，避免干扰业务历史列表。
                </p>
                <button
                  className="ghost-button compact"
                  type="button"
                  onClick={() => setShowSampleCases((current) => !current)}
                >
                  {showSampleCases ? "隐藏测试案件" : `显示测试案件（${hiddenSampleCaseCount}）`}
                </button>
              </div>
            ) : null}
            <div className="filter-row archive-filter-row">
              {Object.entries(caseArchiveFilterLabel).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={
                    caseHistoryFilter === value ? "filter-pill active" : "filter-pill"
                  }
                  onClick={() =>
                    setCaseHistoryFilter(value as keyof typeof caseArchiveFilterLabel)
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            {casesLoading ? (
              <p>正在加载已保存案件...</p>
            ) : filteredCaseHistory.length > 0 ? (
              <>
                {inProgressCases.length > 0 ? (
                  <div className="case-group">
                    <div className="case-group-head">
                      <span>审核中项目</span>
                      <strong>{inProgressCases.length}</strong>
                    </div>
                    <div className="case-history">
                      {inProgressCases.map((entry) => (
                        <button
                          type="button"
                          key={entry.caseId}
                          className={
                            analysis?.caseId === entry.caseId ? "case-link active" : "case-link"
                          }
                          onClick={() => loadCase(entry.caseId)}
                        >
                          <div className="case-link-top">
                            <strong>{entry.businessName ?? entry.caseName}</strong>
                            <span className={`status-tag ${workflowTone[entry.workflow.status]}`}>
                              {workflowLabel[entry.workflow.status]}
                            </span>
                          </div>
                          <div className="item-meta">
                            <span>{entry.createdBy.displayName}</span>
                            <span>{formatDateTime(entry.updatedAt)}</span>
                          </div>
                          <div className="item-meta">
                            <span>{entry.recommendedDecision}</span>
                            <span>ID {shortCaseId(entry.caseId)}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {reviewedCases.length > 0 ? (
                  <div className="case-group">
                    <div className="case-group-head">
                      <span>已审核项目</span>
                      <strong>{reviewedCases.length}</strong>
                    </div>
                    <div className="case-history">
                      {reviewedCases.map((entry) => (
                        <button
                          type="button"
                          key={entry.caseId}
                          className={
                            analysis?.caseId === entry.caseId ? "case-link active" : "case-link"
                          }
                          onClick={() => loadCase(entry.caseId)}
                        >
                          <div className="case-link-top">
                            <strong>{entry.businessName ?? entry.caseName}</strong>
                            <span className={`status-tag ${workflowTone[entry.workflow.status]}`}>
                              {workflowLabel[entry.workflow.status]}
                            </span>
                          </div>
                          <div className="item-meta">
                            <span>{entry.createdBy.displayName}</span>
                            <span>{formatDateTime(entry.updatedAt)}</span>
                          </div>
                          <div className="item-meta">
                            <span>{entry.recommendedDecision}</span>
                            <span>ID {shortCaseId(entry.caseId)}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <p>
                {caseHistory.length > 0
                  ? "未找到符合当前筛选条件的案件，可尝试调整关键词或状态。"
                  : "当前还没有已保存案件，上传并分析一次后会出现在这里。"}
              </p>
            )}
            {casesError ? <p className="hint">{casesError}</p> : null}
          </div>

          <div className="category-list">
            <article className="category-card">
              <span>本次命中</span>
              <strong>{focusItemCount}</strong>
            </article>
            <article className="category-card">
              <span>待处理</span>
              <strong>{scopedPendingCount}</strong>
            </article>
            <article className="category-card">
              <span>必须项</span>
              <strong>{checklistPayload.summary.mandatory_items}</strong>
            </article>
            <article className="category-card">
              <span>当前视图</span>
              <strong>{filteredItems.length}</strong>
            </article>
          </div>

          {analysis ? (
            <div className="summary-card">
              <p className="section-kicker">AI Summary</p>
              <h4>{analysis.summary.recommendedDecision}</h4>
              <p>{analysis.summary.overview}</p>
              <div className="detail-meta">
                <span className={`status-tag ${workflowTone[currentWorkflow.status]}`}>
                  {workflowLabel[currentWorkflow.status]}
                </span>
                {currentWorkflow.expertReviewedAt ? (
                  <span>终审完成于 {formatDateTime(currentWorkflow.expertReviewedAt)}</span>
                ) : currentWorkflow.submittedToExpertAt ? (
                  <span>已送专家复审 {formatDateTime(currentWorkflow.submittedToExpertAt)}</span>
                ) : (
                  <span>尚未进入专家复审</span>
                )}
              </div>
            </div>
          ) : (
            <div className="summary-card">
              <p className="section-kicker">MVP Focus</p>
              <p>
                操作员完成 AI 初判后案件会自动进入专家复审队列；专家账号负责人工覆盖、终审确认与结论导出。
              </p>
            </div>
          )}

          {analysis ? (
            <div className="summary-card">
              <p className="section-kicker">Security Scan</p>
              <h4>{scanReport ? scanReport.summary : "未识别安扫报告"}</h4>
              {scanReport ? (
                <>
                  <div className="detail-meta">
                    <span className={`status-tag ${statusTone[scanReport.status]}`}>
                      {statusLabel[scanReport.status]}
                    </span>
                    <span>{scanReport.qualified ? "安扫结论：合格" : "安扫结论：待处理"}</span>
                  </div>
                  <div className="scan-report-grid">
                    <article className="archive-stat">
                      <span>设备清单</span>
                      <strong>{scanReport.hasDeviceInventory ? "有" : "不足"}</strong>
                    </article>
                    <article className="archive-stat">
                      <span>逐设备漏洞</span>
                      <strong>{scanReport.hasPerDeviceDetails ? "有" : "不足"}</strong>
                    </article>
                    <article className="archive-stat">
                      <span>中高危未处置</span>
                      <strong>{scanReport.mediumHighOpenCount ?? "--"}</strong>
                    </article>
                  </div>
                  {scanReport.devices.length > 0 ? (
                    <ul className="scan-device-list">
                      {scanReport.devices.slice(0, 5).map((device, index) => (
                        <li key={`${device.assetName}-${device.assetIdentifier}-${index}`}>
                          <strong>{device.assetName}</strong>
                          <span>
                            {device.assetIdentifier || "未标明资产标识"} · 高危{" "}
                            {device.highRiskCount ?? "--"} / 中危 {device.mediumRiskCount ?? "--"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : (
                <p>
                  当前未识别到命名为安扫报告/扫描报告的全局材料。若本次审核需要漏洞扫描结论，建议补传正式安扫报告。
                </p>
              )}
            </div>
          ) : null}
        </aside>

        <section className="review-list panel">
          <div className="panel-head">
            <div>
              <p className="section-kicker">Review Result</p>
              <h3>{reviewPanelTitle}</h3>
            </div>
            <span className="soft-badge">
              {analysis ? `${filteredItems.length} / ${checklistItems.length}` : "等待分析"}
            </span>
          </div>
          {analysis ? (
            <>
              <div className="result-rail compact">
                <article className="result-card">
                  <span>当前业务</span>
                  <strong>{analysis.businessName}</strong>
                  <p>{analysis.summary.recommendedDecision}</p>
                </article>
                <article className="result-card">
                  <span>{canExpertReview ? "待复核项" : "待处理项"}</span>
                  <strong>{canExpertReview ? expertReviewItems.length : attentionItems.length}</strong>
                  <p>{nextStepText}</p>
                </article>
                <article className="result-card">
                  <span>{canExpertReview ? "本次命中" : "已命中项"}</span>
                  <strong>{matchedItems.length}</strong>
                  <p>完整清单已降为附录，仅在追溯时查看。</p>
                </article>
              </div>

              <p className="hint review-intro">
                {viewDescription}
              </p>

              <div className="checklist-toolbar">
                <input
                  className="archive-search"
                  value={checklistQuery}
                  placeholder="搜索审查项编号、要求或分类"
                  onChange={(event) => setChecklistQuery(event.target.value)}
                />
                <div className="archive-stats checklist-stats">
                  <article className="archive-stat">
                    <span>{canExpertReview ? "待复核" : "待处理"}</span>
                    <strong>{canExpertReview ? expertReviewItems.length : attentionItems.length}</strong>
                  </article>
                  <article className="archive-stat">
                    <span>已命中</span>
                    <strong>{matchedItems.length}</strong>
                  </article>
                  <article className="archive-stat">
                    <span>当前显示</span>
                    <strong>{filteredItems.length}</strong>
                  </article>
                </div>
              </div>

              <div className="filter-row">
                {reviewTabOptions.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={resultView === value ? "filter-pill active" : "filter-pill"}
                    onClick={() => setResultView(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {filteredItems.length > 0 ? (
                <div className="items">
                  {filteredItems.map((item) => {
                    const result = resultMap.get(item.code);
                    const tone = statusTone[result?.status ?? "pending"];
                    return (
                      <button
                        type="button"
                        key={item.code}
                        className={selectedCode === item.code ? "item-row active" : "item-row"}
                        onClick={() => setSelectedCode(item.code)}
                      >
                        <div className="item-topline">
                          <span className="item-code">{item.code}</span>
                          {item.mandatory ? <span className="must-tag">必须</span> : null}
                          {hasEvidenceMatch(item.code) ? (
                            <span className="soft-badge">已命中材料</span>
                          ) : null}
                          <span className={`status-tag ${tone}`}>
                            {statusLabel[result?.status ?? "pending"]}
                          </span>
                        </div>
                        <p>{item.requirement}</p>
                        <div className="item-meta">
                          <span>{item.category}</span>
                          <span>置信度 {result?.confidence ?? 0}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="empty-card">
                  <strong>当前筛选下没有命中条目</strong>
                  <p>可切换到“待处理/待复核”“已命中”或“完整附录”，也可以调整搜索关键词重新查看。</p>
                </div>
              )}
            </>
          ) : (
            <div className="empty-card">
              <strong>{canExpertReview ? "从左侧选择待复审案件后，这里只展示复核重点" : "上传并分析后，这里只展示当前业务的结论和待处理项"}</strong>
              <p>{canExpertReview ? "专家无需先浏览完整清单；选择一条待复审业务后，中间区域会直接聚焦待复核项和问题项。" : "固定审查清单已内置，无需先浏览全部条目。开始分析后，再按待处理项、已命中项或完整附录查看结果。"}</p>
            </div>
          )}
        </section>

        <aside className="detail panel">
          <div className="panel-head">
            <div>
              <p className="section-kicker">Detail</p>
              <h3>{selectedChecklist?.code ?? "未选择"}</h3>
            </div>
            <span className={`status-tag ${statusTone[selectedResult?.status ?? "pending"]}`}>
              {statusLabel[selectedResult?.status ?? "pending"]}
            </span>
          </div>

          {selectedChecklist ? (
            <>
              <article className="detail-card">
                <h4>审查要求</h4>
                <p>{selectedChecklist.requirement}</p>
                <div className="detail-meta">
                  <span>{selectedChecklist.category}</span>
                  <span>{selectedChecklist.mandatory ? "必须项" : "可选项"}</span>
                </div>
              </article>

              <article className="detail-card">
                <h4>AI 理由</h4>
                <p>{selectedResult?.rationale ?? "尚未运行分析。"}</p>
                <div className="detail-meta">
                  <span>置信度 {selectedResult?.confidence ?? 0}</span>
                  <span>{selectedResult?.nextAction ?? "待分析"}</span>
                </div>
              </article>

              <article className="detail-card">
                <h4>依据</h4>
                {selectedResult?.basis?.length ? (
                  <ul className="evidence-list">
                    {selectedResult.basis.map((entry, index) => (
                      <li key={`${selectedChecklist.code}-basis-${index}`}>{entry}</li>
                    ))}
                  </ul>
                ) : (
                  <p>当前暂无结构化依据。</p>
                )}
              </article>

              <article className="detail-card">
                <h4>整改项 / 参考做法</h4>
                <p>{selectedResult?.remediation ?? "暂无。"}</p>
                <div className="detail-meta">
                  <span>{selectedResult?.referenceMethod ?? "暂无参考做法。"}</span>
                </div>
              </article>

              <article className="detail-card">
                <h4>证据文件</h4>
                {selectedResult?.evidenceFiles?.length ? (
                  <ul className="evidence-list">
                    {selectedResult.evidenceFiles.map((name) => (
                      <li key={name}>{name}</li>
                    ))}
                  </ul>
                ) : (
                  <p>当前条目尚未命中明确证据。</p>
                )}
              </article>

              <article className="detail-card">
                <h4>复审流转</h4>
                <div className="detail-meta">
                  <span className={`status-tag ${workflowTone[currentWorkflow.status]}`}>
                    {workflowLabel[currentWorkflow.status]}
                  </span>
                  {currentWorkflow.submittedToExpertAt ? (
                    <span>送审于 {formatDateTime(currentWorkflow.submittedToExpertAt)}</span>
                  ) : (
                    <span>尚未送审</span>
                  )}
                </div>
                <p>
                  {currentWorkflow.status === "pending_expert_review"
                    ? "当前案件已进入专家复审队列，专家账号登录后可直接查看并完成终审。"
                    : currentWorkflow.status === "expert_reviewed"
                      ? "当前案件已完成专家终审；若操作员补充材料并重新分析，可再次送专家确认。"
                      : "操作员完成 AI 初判后会自动进入专家复审队列，也支持手动重新提交专家复审。"}
                </p>
              </article>

              <article className="detail-card">
                <h4>人工覆盖</h4>
                {canExpertReview ? (
                  <div className="override-row">
                    <button type="button" onClick={() => applyOverride("pass")}>
                      标记符合
                    </button>
                    <button type="button" onClick={() => applyOverride("fail")}>
                      标记不符合
                    </button>
                    <button
                      type="button"
                      onClick={() => applyOverride("insufficient_evidence")}
                    >
                      证据不足
                    </button>
                    <button
                      type="button"
                      onClick={() => applyOverride("manual_review_required")}
                    >
                      待人工复核
                    </button>
                  </div>
                ) : (
                  <p>当前为普通上传审核账号，仅专家账号可执行人工覆盖和最终导出。</p>
                )}
              </article>
            </>
          ) : (
            <article className="detail-card">
              <p>请选择一条审查项查看详情。</p>
            </article>
          )}
        </aside>
      </section>

      {analysis?.evidences?.length ? (
        <section className="evidence-panel panel">
          <div className="panel-head">
            <div>
              <p className="section-kicker">Evidence</p>
              <h3>抽取结果</h3>
            </div>
            <div className="mechanism-actions">
              <span className="soft-badge">{analysis.evidences.length} files</span>
              <button
                className="ghost-button compact"
                type="button"
                onClick={() => setShowEvidencePanel((current) => !current)}
              >
                {showEvidencePanel ? "收起抽取文本" : "查看抽取文本"}
              </button>
            </div>
          </div>

          {showEvidencePanel ? (
            <div className="evidence-grid">
              {analysis.evidences.map((evidence) => (
                <article className="evidence-card" key={evidence.id}>
                  <div className="evidence-card-head">
                    <strong>{evidence.fileName}</strong>
                    <span>{evidence.source}</span>
                  </div>
                  <p>{evidence.summary}</p>
                  <div className="detail-meta">
                    <span>{evidence.namingHint}</span>
                    <span>
                      {evidence.globalEvidence
                        ? "全局材料"
                        : evidence.linkedCodes.length > 0
                          ? `命中 ${evidence.linkedCodes.join(", ")}`
                          : "未自动归档"}
                    </span>
                  </div>
                  <pre>{evidence.extractedText.slice(0, 500) || "未提取到有效文本。"}</pre>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-card">
              <strong>抽取文本已默认收起</strong>
              <p>日常审核优先看业务结论、问题项和待复核项；只有在需要追溯 OCR / 文档抽取内容时再展开查看。</p>
            </div>
          )}
        </section>
      ) : null}
    </main>
  );
}

export default App;
