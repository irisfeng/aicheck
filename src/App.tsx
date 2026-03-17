import { useEffect, useState } from "react";
import checklistPayload from "../data/review_checklist.extracted.json";
import type {
  AnalysisResponse,
  AuthRole,
  AuthUser,
  ChecklistRecord,
  ReviewItemResult,
  ReviewStatus,
} from "./types";

const checklistItems = checklistPayload.items as ChecklistRecord[];
const sessionStorageKey = "aicheck_session_token";

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

function App() {
  const [authToken, setAuthToken] = useState(
    () => window.localStorage.getItem(sessionStorageKey) ?? "",
  );
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(Boolean(authToken));
  const [loginForm, setLoginForm] = useState({ username: "", password: "" });

  const [caseName, setCaseName] = useState("语音业务接入审核案件");
  const [notes, setNotes] = useState(
    "优先关注黄底必须项；若证据不足，宁可判为待人工复核。",
  );
  const [files, setFiles] = useState<File[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<
    "all" | "mandatory" | "blockers" | "unresolved"
  >("all");
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [manualOverrides, setManualOverrides] = useState<
    Record<string, ReviewItemResult>
  >({});
  const [selectedCode, setSelectedCode] = useState<string>(
    checklistItems[0]?.code ?? "",
  );

  const canExpertReview = authUser?.role === "expert";

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
        evidenceFiles: [],
        nextAction: "上传材料后点击开始分析。",
      }
    );
  });

  const filteredItems = checklistItems.filter((item) => {
    const result = mergedItems.find((entry) => entry.code === item.code);
    if (!result) return true;
    if (filter === "mandatory") return item.mandatory;
    if (filter === "blockers") return item.mandatory && result.status === "fail";
    if (filter === "unresolved") {
      return (
        result.status === "insufficient_evidence" ||
        result.status === "manual_review_required" ||
        result.status === "pending"
      );
    }
    return true;
  });

  const selectedChecklist = checklistItems.find((item) => item.code === selectedCode);
  const selectedResult =
    mergedItems.find((item) => item.code === selectedCode) ?? mergedItems[0];

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

  async function handleLogin() {
    setAuthError("");
    setAuthLoading(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(loginForm),
      });

      const payload = await response.json();
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
      setAuthLoading(false);
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
      window.localStorage.removeItem(sessionStorageKey);
    }
  }

  async function handleSubmit() {
    setError("");
    setIsSubmitting(true);

    try {
      const formData = new FormData();
      formData.append("caseName", caseName);
      formData.append("notes", notes);
      files.forEach((file) => formData.append("files", file));

      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
        body: formData,
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "分析失败，请稍后重试。");
      }

      setAnalysis(payload as AnalysisResponse);
      setManualOverrides({});
      if (payload.items?.[0]?.code) {
        setSelectedCode(payload.items[0].code);
      }
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

  function applyOverride(status: ReviewStatus) {
    if (!canExpertReview || !selectedChecklist || !selectedResult) return;

    setManualOverrides((current) => ({
      ...current,
      [selectedChecklist.code]: {
        ...selectedResult,
        status,
        confidence: Math.max(selectedResult.confidence, 95),
        rationale:
          selectedResult.rationale +
          "\n\n[人工覆盖] 专家审核员已在内部工具中手动调整该项结论。",
        nextAction: "人工覆盖已完成，请在提交前复核证据链。",
      },
    }));
  }

  function exportSummary() {
    if (!canExpertReview) return;

    const lines = [
      `# ${caseName} - Review Export`,
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
              <input
                type="password"
                value={loginForm.password}
                onChange={(event) =>
                  setLoginForm((current) => ({
                    ...current,
                    password: event.target.value,
                  }))
                }
              />
            </label>
          </div>

          <div className="action-row login-actions">
            <button className="primary-button" type="button" onClick={handleLogin}>
              登录进入
            </button>
            <p className="hint">测试账号可在 `.env` 中按角色配置。</p>
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

      <section className="intake-panel">
        <div className="intake-head">
          <div>
            <p className="section-kicker">Case Intake</p>
            <h2>上传材料并发起预审</h2>
          </div>
          <button
            className="ghost-button"
            type="button"
            onClick={exportSummary}
            disabled={!canExpertReview}
          >
            导出当前结论
          </button>
        </div>

        <div className="intake-grid">
          <label className="field">
            <span>案件名称</span>
            <input value={caseName} onChange={(event) => setCaseName(event.target.value)} />
          </label>

          <label className="field field-wide">
            <span>审核备注 / 补充要求</span>
            <textarea
              rows={4}
              value={notes}
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
              支持图片、PDF、DOCX、TXT、MD、JSON。建议按
              <code>2.8.1.1.png</code>、
              <code>2.8.1.1-1.png</code>、
              <code>安扫报告.pdf</code>
              命名，系统会优先按文件名前缀自动归档。
            </span>
          </label>
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

        <div className="action-row">
          <button
            className="primary-button"
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting}
          >
            {isSubmitting ? "分析中..." : "开始分析"}
          </button>
          <p className="hint">
            默认调用链路：<code>qwen-vl-ocr</code> -&gt; <code>qwen-flash</code>。如启用视觉增强，可追加 <code>qwen3-vl-flash</code>。
          </p>
        </div>

        {error ? <p className="error-banner">{error}</p> : null}
      </section>

      <section className="workspace">
        <aside className="navigator panel">
          <div className="panel-head">
            <div>
              <p className="section-kicker">Filters</p>
              <h3>审查视图</h3>
            </div>
          </div>

          <div className="filter-row">
            {[
              ["all", "全部"],
              ["mandatory", "必须项"],
              ["blockers", "阻断项"],
              ["unresolved", "待处理"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={filter === value ? "filter-pill active" : "filter-pill"}
                onClick={() => setFilter(value as typeof filter)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="category-list">
            {Object.entries(checklistPayload.summary.categories).map(([category, count]) => (
              <article className="category-card" key={category}>
                <span>{category}</span>
                <strong>{count}</strong>
              </article>
            ))}
          </div>

          {analysis ? (
            <div className="summary-card">
              <p className="section-kicker">AI Summary</p>
              <h4>{analysis.summary.recommendedDecision}</h4>
              <p>{analysis.summary.overview}</p>
            </div>
          ) : (
            <div className="summary-card">
              <p className="section-kicker">MVP Focus</p>
              <p>
                普通账号只负责上传和初判，专家账号负责人工覆盖与结论导出，这样最符合内部工具的最小职责分离。
              </p>
            </div>
          )}
        </aside>

        <section className="review-list panel">
          <div className="panel-head">
            <div>
              <p className="section-kicker">Checklist</p>
              <h3>逐条审查</h3>
            </div>
            <span className="soft-badge">{filteredItems.length} items</span>
          </div>

          <div className="items">
            {filteredItems.map((item) => {
              const result = mergedItems.find((entry) => entry.code === item.code);
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
            <span className="soft-badge">{analysis.evidences.length} files</span>
          </div>

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
        </section>
      ) : null}
    </main>
  );
}

export default App;
