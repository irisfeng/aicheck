import mammoth from "mammoth";
import pdf from "pdf-parse/lib/pdf-parse.js";

export async function extractDocumentText(file) {
  const mimeType = file.mimetype || "";
  const originalName = file.originalname || "";
  const extension = originalName.toLowerCase().split(".").pop() || "";

  if (mimeType.startsWith("image/")) {
    return { source: "ocr", text: "", summary: "等待 OCR 提取。" };
  }

  if (mimeType === "application/pdf" || extension === "pdf") {
    const parsed = await pdf(file.buffer);
    return {
      source: "document",
      text: parsed.text?.trim() ?? "",
      summary: "已从 PDF 中抽取文本。",
    };
  }

  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    extension === "docx"
  ) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return {
      source: "document",
      text: result.value?.trim() ?? "",
      summary: "已从 DOCX 中抽取文本。",
    };
  }

  if (
    mimeType.startsWith("text/") ||
    ["txt", "md", "json", "csv", "log"].includes(extension)
  ) {
    return {
      source: "text",
      text: file.buffer.toString("utf-8").trim(),
      summary: "已读取文本类文件。",
    };
  }

  return {
    source: "document",
    text: "",
    summary: "当前 MVP 不解析该格式，将仅保留文件名供人工参考。",
  };
}
