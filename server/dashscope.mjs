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

export async function reviewChecklist({
  caseName,
  notes,
  checklist,
  evidenceIndex,
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
    };
  });

  const prompt = `
你是一个内部网信安审核助手。请基于案件材料，对审查项逐条给出保守判断。

规则：
1. 只允许输出以下状态之一：pass, fail, insufficient_evidence, manual_review_required
2. 对必须项必须保守：证据不充分时优先 insufficient_evidence 或 manual_review_required
3. 不要捏造证据，不要引用不存在的文件
4. confidence 为 0-100 的整数
5. evidenceFiles 只写文件名数组
6. nextAction 要简短可执行
7. 输出必须是严格 JSON，不要 Markdown，不要解释

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
