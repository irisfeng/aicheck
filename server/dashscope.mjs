const baseUrl =
  process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";

function getApiKey() {
  return process.env.DASHSCOPE_API_KEY ?? "";
}

function dataUrlFromFile(file) {
  const mime = file.mimetype || "application/octet-stream";
  return `data:${mime};base64,${file.buffer.toString("base64")}`;
}

function normalizeMessageContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.text) return part.text;
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
}

function parseJsonResponse(text) {
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

function safeInteger(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const matched = value.match(/-?\d+/);
    if (matched) {
      return Number.parseInt(matched[0], 10);
    }
  }
  return null;
}

async function chatCompletion({ model, messages, temperature = 0.2, maxTokens = 4096 }) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("未配置 DASHSCOPE_API_KEY，无法调用百炼 API。");
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`百炼接口调用失败（${response.status}）：${body.slice(0, 400)}`);
  }

  const payload = await response.json();
  const text = normalizeMessageContent(payload?.choices?.[0]?.message?.content);
  return { payload, text };
}

export async function ocrImage(file) {
  const model = process.env.DASHSCOPE_OCR_MODEL ?? "qwen-vl-ocr-latest";
  const prompt =
    "你是一个严谨的 OCR 引擎。请提取图片中所有可读文字，尽量保留层级、编号、配置项名称、字段值、列表和表格结构。不要解释，不要总结，只输出纯文本。";

  const { text } = await chatCompletion({
    model,
    messages: [
      { role: "system", content: "You are a precise OCR engine." },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUrlFromFile(file) } },
        ],
      },
    ],
    temperature: 0,
    maxTokens: 3000,
  });

  return text.trim();
}

export async function enrichImage(file) {
  const enabled = process.env.DASHSCOPE_ENABLE_VISION_ENRICHMENT === "true";
  if (!enabled) return "";

  const model = process.env.DASHSCOPE_VISION_MODEL ?? "qwen3-vl-flash";
  const prompt =
    "请只描述截图中与安全审核相关的可见信息，例如登录策略、IP 白名单、防火墙规则、日志留存、双因子、端口、协议、时间范围等。禁止脑补。输出 5 条以内短句。";

  const { text } = await chatCompletion({
    model,
    messages: [
      {
        role: "system",
        content: "You describe only visible, security-relevant details conservatively.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUrlFromFile(file) } },
        ],
      },
    ],
    temperature: 0.2,
    maxTokens: 1200,
  });

  return text.trim();
}

export async function reviewMandatoryItemWithVision({
  item,
  imageFiles,
  ocrSnippets,
  notes,
}) {
  const enabled = process.env.DASHSCOPE_ENABLE_MANDATORY_VISION_RECHECK !== "false";
  if (!enabled || !Array.isArray(imageFiles) || imageFiles.length === 0) {
    return null;
  }

  const model = process.env.DASHSCOPE_VISION_MODEL ?? "qwen3-vl-flash";
  const maxImages = Number(process.env.DASHSCOPE_MANDATORY_VISION_MAX_IMAGES || 3);
  const selectedFiles = imageFiles.slice(0, Math.max(1, maxImages));

  const prompt = `
你是网信安技术审核专家。现在只审核一条“必须项”，请基于截图做保守判断。

要求：
1. 只能依据截图中可见内容判断，禁止脑补
2. 如果截图无法清楚证明要求已满足，优先输出 insufficient_evidence 或 manual_review_required
3. 只允许状态：pass, fail, insufficient_evidence, manual_review_required
4. confidence 为 0-100 的整数
5. evidenceFiles 只写当前这批截图文件名
6. basis 写成简短数组，说明看到了什么、缺了什么、冲突点是什么
7. remediation 写整改项
8. referenceMethod 写补充截图或整改参考方法
9. 输出必须是严格 JSON

审查项编号：${item.code}
审查项内容：${item.requirement}
审核备注：${notes || "无"}
OCR 摘要：
${JSON.stringify(ocrSnippets.slice(0, 3), null, 2)}

返回格式：
{
  "code": "${item.code}",
  "status": "pass",
  "confidence": 88,
  "rationale": "简要判断",
  "basis": ["依据1", "依据2"],
  "remediation": "整改项",
  "referenceMethod": "补充截图或参考做法",
  "evidenceFiles": ["${selectedFiles[0]?.originalname ?? `${item.code}.png`}"]
}
`;

  const { text } = await chatCompletion({
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a conservative visual compliance reviewer. Return strict JSON only.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...selectedFiles.map((file) => ({
            type: "image_url",
            image_url: { url: dataUrlFromFile(file) },
          })),
        ],
      },
    ],
    temperature: 0.1,
    maxTokens: 2200,
  });

  return parseJsonResponse(text);
}

export async function analyzeSecurityScanReport({
  businessName,
  notes,
  reportEvidences,
  reportImageFiles = [],
}) {
  if (!Array.isArray(reportEvidences) || reportEvidences.length === 0) {
    return null;
  }

  const visionModel = process.env.DASHSCOPE_VISION_MODEL ?? "qwen3-vl-plus";
  const model = visionModel;
  const selectedImages = reportImageFiles.slice(0, 4);

  const prompt = `
你是网络安全审核助手，现在要对“安扫/漏洞扫描报告”做通用型合格性判断。

请不要绑定某一家厂商模板，但可以参考正规云厂商和安全厂商报告的共性做法。判断口径要通用、保守、不过度苛刻：
1. 是否能识别出受检设备/资产清单，至少能看出扫描对象或设备列表
2. 是否能识别出每台设备的漏洞概况，或至少存在按设备/资产区分的漏洞结果
2a. 如果正文中已经明确写出“设备名/IP + 高危/中危/低危数量或漏洞结果”，即使不是标准表格，也应认定为已具备逐设备结果
3. 如果报告明确显示仍存在未处理的中危、高危或严重漏洞，则判为 fail
4. 如果报告明确说明没有中高危未处理漏洞，且资产清单、按设备结果都较完整，可判为 pass
5. 如果报告只有总览，没有设备清单或看不出每台设备漏洞情况，则优先判为 insufficient_evidence
6. 只能依据材料中可见内容判断，禁止脑补
7. 输出必须为严格 JSON

案件名称：${businessName}
审核备注：${notes || "无"}

报告材料摘要：
${JSON.stringify(
    reportEvidences.map((evidence) => ({
      fileName: evidence.fileName,
      summary: evidence.summary,
      extractedText: evidence.extractedText.slice(0, 5000),
    })),
    null,
    2,
  )}

返回格式：
{
  "status": "pass",
  "confidence": 86,
  "qualified": true,
  "hasDeviceInventory": true,
  "hasPerDeviceDetails": true,
  "totalDevices": 6,
  "mediumHighOpenCount": 0,
  "summary": "一句话总结安扫报告是否合格",
  "basis": ["依据1", "依据2"],
  "remediation": "若不合格或证据不足，给出整改项",
  "referenceMethod": "补充报告或截图参考方式",
  "evidenceFiles": ["安扫报告.pdf"],
  "devices": [
    {
      "assetName": "语音网关01",
      "assetIdentifier": "10.0.0.8",
      "highRiskCount": 0,
      "mediumRiskCount": 0,
      "lowRiskCount": 2,
      "status": "pass"
    }
  ]
}
`;

  const userContent =
    selectedImages.length > 0
      ? [
          { type: "text", text: prompt },
          ...selectedImages.map((file) => ({
            type: "image_url",
            image_url: { url: dataUrlFromFile(file) },
          })),
        ]
      : prompt;

  const { text } = await chatCompletion({
    model,
    messages: [
      {
        role: "system",
        content:
          "You assess vulnerability scan reports conservatively and return strict JSON only.",
      },
      {
        role: "user",
        content: userContent,
      },
    ],
    temperature: 0.1,
    maxTokens: 3200,
  });

  const parsed = parseJsonResponse(text);
  const normalizedDevices = Array.isArray(parsed.devices)
    ? parsed.devices.slice(0, 12).map((device) => ({
        assetName: String(device?.assetName || "").trim() || "未命名设备",
        assetIdentifier: String(device?.assetIdentifier || "").trim(),
        highRiskCount: safeInteger(device?.highRiskCount),
        mediumRiskCount: safeInteger(device?.mediumRiskCount),
        lowRiskCount: safeInteger(device?.lowRiskCount),
        status:
          device?.status === "pass" || device?.status === "fail"
            ? device.status
            : "unknown",
      }))
    : [];

  const normalizedStatus =
    parsed.status === "pass" ||
    parsed.status === "fail" ||
    parsed.status === "insufficient_evidence" ||
    parsed.status === "manual_review_required"
      ? parsed.status
      : "insufficient_evidence";
  const mediumHighOpenCount = safeInteger(parsed.mediumHighOpenCount);
  const hasDeviceInventory = Boolean(parsed.hasDeviceInventory);
  const hasPerDeviceDetails = Boolean(parsed.hasPerDeviceDetails);
  const qualified = Boolean(parsed.qualified);
  const finalStatus =
    mediumHighOpenCount !== null && mediumHighOpenCount > 0
      ? "fail"
      : !hasDeviceInventory || !hasPerDeviceDetails
        ? normalizedStatus === "pass"
          ? "insufficient_evidence"
          : normalizedStatus
        : qualified && normalizedStatus === "pass"
          ? "pass"
          : normalizedStatus;

  return {
    status: finalStatus,
    confidence: safeInteger(parsed.confidence) ?? 0,
    qualified: finalStatus === "pass",
    hasDeviceInventory,
    hasPerDeviceDetails,
    totalDevices: safeInteger(parsed.totalDevices),
    mediumHighOpenCount,
    summary: String(parsed.summary || "").trim() || "未能形成稳定的安扫报告结论。",
    basis: Array.isArray(parsed.basis) ? parsed.basis.filter(Boolean).map(String) : [],
    remediation: String(parsed.remediation || "").trim() || "请补充完整安扫报告或确认漏洞处置情况。",
    referenceMethod:
      String(parsed.referenceMethod || "").trim() ||
      "建议补充包含设备清单、每台设备漏洞概况和风险等级汇总的安扫报告。",
    evidenceFiles: Array.isArray(parsed.evidenceFiles)
      ? parsed.evidenceFiles.filter(Boolean).map(String)
      : reportEvidences.map((evidence) => evidence.fileName),
    devices: normalizedDevices,
  };
}

export async function reviewChecklist({
  caseName,
  notes,
  checklist,
  evidenceIndex,
  visionAssessments = {},
  scanReportAssessment = null,
}) {
  const model = process.env.DASHSCOPE_SUMMARY_MODEL ?? "qwen-flash";
  const mandatoryCount = checklist.filter((item) => item.mandatory).length;
  const globalEvidencePayload = evidenceIndex.globalEvidences.map((evidence) => ({
    fileName: evidence.fileName,
    summary: evidence.summary,
    extractedText: evidence.extractedText.slice(0, 2200),
  }));

  const checklistPayload = checklist.map((item) => {
    const directEvidence = (evidenceIndex.directByCode[item.code] ?? []).map((evidence) => ({
      fileName: evidence.fileName,
      summary: evidence.summary,
      extractedText: evidence.extractedText.slice(0, 2200),
    }));

    return {
      code: item.code,
      category: item.category,
      mandatory: item.mandatory,
      requirement: item.requirement,
      directEvidence,
      visionRecheck: visionAssessments[item.code] ?? null,
      scanReportAssessment:
        /漏洞扫描|安扫|扫描报告/u.test(item.requirement) && scanReportAssessment
          ? scanReportAssessment
          : null,
    };
  });

  const prompt = `
你是一个内部网信安审核助手。请基于案件材料，对审查项逐条给出保守判断。

规则：
1. 只允许输出以下状态之一：pass, fail, insufficient_evidence, manual_review_required
2. 对必须项必须保守：证据不充分时优先 insufficient_evidence 或 manual_review_required
3. 不要捏造证据，不要引用不存在的文件
4. 如果某个必须项携带 visionRecheck，请优先参考视觉复判结果；当 OCR 与视觉冲突时，按更保守的结论输出
5. 如果某个条目携带 scanReportAssessment，请把它当作安扫专项证据来综合判断
5. confidence 为 0-100 的整数
6. evidenceFiles 只写文件名数组
7. basis 为简洁数组，写出判断依据、缺失证据点或冲突点
8. remediation 仅在 fail / insufficient_evidence / manual_review_required 时重点给出，pass 时可以简短
9. referenceMethod 给出一个简短参考做法，偏向截图补充建议或整改方向
10. nextAction 要简短可执行
11. 输出必须是严格 JSON，不要 Markdown，不要解释

案件名：${caseName}
审核备注：${notes || "无"}
必须项数量：${mandatoryCount}

全局材料（适用于所有条目，如安扫报告）：
${JSON.stringify(globalEvidencePayload, null, 2)}

审查项与直连证据：
${JSON.stringify(checklistPayload, null, 2)}

返回格式：
{
  "summary": {
    "recommendedDecision": "待人工复核 / 待补件 / 可进入人工终审 / 建议驳回",
    "blockerCount": 0,
    "unresolvedCount": 0,
    "mandatoryPassCount": 0,
    "totalMandatoryCount": ${mandatoryCount},
    "overview": "一句话概述"
  },
  "items": [
    {
      "code": "2.8.1.1",
      "status": "pass",
      "confidence": 88,
      "rationale": "简明理由",
      "basis": ["依据1", "依据2"],
      "remediation": "如不符合时给出整改项",
      "referenceMethod": "建议补充哪类截图或参考配置方式",
      "evidenceFiles": ["xxx.png"],
      "nextAction": "如需补件给出动作"
    }
  ]
}
`;

  const { text } = await chatCompletion({
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a conservative compliance reviewer. Return strict JSON only.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.15,
    maxTokens: 8192,
  });

  return parseJsonResponse(text);
}

export function getProviderLabel() {
  return "DashScope / Bailian";
}

export function isApiConfigured() {
  return Boolean(getApiKey());
}
