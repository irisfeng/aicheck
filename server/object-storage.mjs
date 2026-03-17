import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let client;

function getBucketName() {
  return process.env.R2_BUCKET || "";
}

function getEndpoint() {
  if (process.env.R2_ENDPOINT) {
    return process.env.R2_ENDPOINT;
  }

  const accountId = process.env.R2_ACCOUNT_ID || "";
  if (!accountId) return "";

  return `https://${accountId}.r2.cloudflarestorage.com`;
}

function getAccessKeyId() {
  return process.env.R2_ACCESS_KEY_ID || "";
}

function getSecretAccessKey() {
  return process.env.R2_SECRET_ACCESS_KEY || "";
}

export function isObjectStorageConfigured() {
  return Boolean(getBucketName() && getEndpoint() && getAccessKeyId() && getSecretAccessKey());
}

export function getObjectStorageLabel() {
  return isObjectStorageConfigured() ? "Cloudflare R2" : "No object storage configured";
}

function getPresignExpiresSeconds() {
  const value = Number(process.env.R2_PRESIGN_EXPIRES_SECONDS || 600);
  if (Number.isNaN(value)) return 600;
  return Math.min(Math.max(value, 60), 3600);
}

function getClient() {
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: getEndpoint(),
      credentials: {
        accessKeyId: getAccessKeyId(),
        secretAccessKey: getSecretAccessKey(),
      },
    });
  }

  return client;
}

function sanitizeFileName(fileName) {
  return String(fileName || "upload.bin")
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .slice(-120);
}

function buildObjectKey({ caseId, fileName, username }) {
  const day = new Date().toISOString().slice(0, 10);
  const safeName = sanitizeFileName(fileName);
  const safeCaseId = String(caseId || "temp").replace(/[^a-zA-Z0-9_-]/g, "-");
  const safeUser = String(username || "anonymous").replace(/[^a-zA-Z0-9_-]/g, "-");
  return `voice-review/${day}/${safeUser}/${safeCaseId}/${randomUUID()}-${safeName}`;
}

async function bodyToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (typeof body.transformToByteArray === "function") {
    const bytes = await body.transformToByteArray();
    return Buffer.from(bytes);
  }

  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function createUploadTargets({ files, caseId, username }) {
  if (!isObjectStorageConfigured()) {
    throw new Error("Cloudflare R2 未配置，无法生成上传地址。");
  }

  const bucket = getBucketName();
  const expiresIn = getPresignExpiresSeconds();
  const s3 = getClient();

  return Promise.all(
    files.map(async (file) => {
      const objectKey = buildObjectKey({
        caseId,
        fileName: file.fileName,
        username,
      });

      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        ContentType: file.mimeType || "application/octet-stream",
      });

      const uploadUrl = await getSignedUrl(s3, command, { expiresIn });
      return {
        fileName: file.fileName,
        mimeType: file.mimeType || "application/octet-stream",
        size: Number(file.size || 0),
        objectKey,
        uploadUrl,
        expiresIn,
      };
    }),
  );
}

export async function readUploadedObject(uploadedFile) {
  if (!isObjectStorageConfigured()) {
    throw new Error("Cloudflare R2 未配置，无法读取已上传文件。");
  }

  const objectKey = String(uploadedFile.objectKey || "");
  if (!objectKey) {
    throw new Error("缺少 objectKey。");
  }

  const response = await getClient().send(
    new GetObjectCommand({
      Bucket: getBucketName(),
      Key: objectKey,
    }),
  );

  const buffer = await bodyToBuffer(response.Body);

  return {
    originalname: uploadedFile.fileName,
    mimetype: uploadedFile.mimeType || response.ContentType || "application/octet-stream",
    size: uploadedFile.size || buffer.length,
    buffer,
    objectKey,
  };
}

export async function readUploadedObjects(uploadedFiles) {
  return Promise.all(uploadedFiles.map((file) => readUploadedObject(file)));
}
