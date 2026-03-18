import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const memoryStore = new Map();

let pool;
let schemaPromise;

function normalizeWorkflow(workflow) {
  if (!workflow || typeof workflow !== "object") {
    return {
      status: "draft",
    };
  }

  return {
    status: workflow.status || "draft",
    submittedToExpertAt: workflow.submittedToExpertAt || undefined,
    submittedToExpertBy: workflow.submittedToExpertBy || undefined,
    expertReviewedAt: workflow.expertReviewedAt || undefined,
    expertReviewedBy: workflow.expertReviewedBy || undefined,
  };
}

function workflowRank(status) {
  switch (status) {
    case "pending_expert_review":
      return 0;
    case "draft":
      return 1;
    case "expert_reviewed":
      return 2;
    default:
      return 3;
  }
}

function getDatabaseUrl() {
  return process.env.DATABASE_URL ?? "";
}

function usingPostgres() {
  return Boolean(getDatabaseUrl());
}

function getSslMode(databaseUrl) {
  const explicitMode = String(process.env.PGSSLMODE || "").trim().toLowerCase();
  if (explicitMode) {
    return explicitMode;
  }

  if (!databaseUrl) {
    return "";
  }

  try {
    return new URL(databaseUrl).searchParams.get("sslmode")?.toLowerCase() || "";
  } catch {
    return "";
  }
}

function normalizeDatabaseUrl(databaseUrl) {
  if (!databaseUrl) return "";

  try {
    const url = new URL(databaseUrl);
    const sslMode = getSslMode(databaseUrl);

    if (sslMode === "disable") {
      url.searchParams.set("sslmode", "disable");
      return url.toString();
    }

    // Keep the current secure behavior explicit and avoid pg's future-semantics warning.
    url.searchParams.set("sslmode", "verify-full");
    return url.toString();
  } catch {
    return databaseUrl;
  }
}

function getSslConfig(databaseUrl) {
  const sslMode = getSslMode(databaseUrl);

  if (sslMode === "disable") {
    return false;
  }

  if (String(process.env.PGSSL_INSECURE || "").trim().toLowerCase() === "true") {
    return { rejectUnauthorized: false };
  }

  return true;
}

function getPool() {
  if (!pool) {
    const databaseUrl = getDatabaseUrl();

    pool = new Pool({
      connectionString: normalizeDatabaseUrl(databaseUrl),
      ssl: getSslConfig(databaseUrl),
    });
  }

  return pool;
}

async function ensurePostgresSchema() {
  if (!usingPostgres()) return;
  if (!schemaPromise) {
    schemaPromise = getPool().query(`
      CREATE TABLE IF NOT EXISTS review_cases (
        id text PRIMARY KEY,
        case_name text NOT NULL,
        notes text NOT NULL DEFAULT '',
        provider text NOT NULL DEFAULT '',
        created_by_username text NOT NULL,
        created_by_display_name text NOT NULL,
        created_by_role text NOT NULL,
        updated_by_username text NOT NULL,
        updated_by_display_name text NOT NULL,
        updated_by_role text NOT NULL,
        recommended_decision text NOT NULL DEFAULT '',
        blocker_count integer NOT NULL DEFAULT 0,
        unresolved_count integer NOT NULL DEFAULT 0,
        mandatory_pass_count integer NOT NULL DEFAULT 0,
        total_mandatory_count integer NOT NULL DEFAULT 0,
        review_data jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS review_cases_updated_at_idx
        ON review_cases (updated_at DESC);

      CREATE INDEX IF NOT EXISTS review_cases_created_by_username_idx
        ON review_cases (created_by_username);
    `);
  }

  await schemaPromise;
}

function toCaseSummary(record) {
  return {
    caseId: record.id,
    businessName: record.case_name,
    caseName: record.case_name,
    workflow: normalizeWorkflow(record.review_data?.workflow),
    recommendedDecision: record.recommended_decision,
    blockerCount: record.blocker_count,
    unresolvedCount: record.unresolved_count,
    mandatoryPassCount: record.mandatory_pass_count,
    totalMandatoryCount: record.total_mandatory_count,
    createdBy: {
      username: record.created_by_username,
      displayName: record.created_by_display_name,
      role: record.created_by_role,
    },
    updatedBy: {
      username: record.updated_by_username,
      displayName: record.updated_by_display_name,
      role: record.updated_by_role,
    },
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function hasCaseAccess(record, user) {
  if (!record) return false;
  if (user.role === "expert") return true;
  return record.created_by_username === user.username;
}

function memoryRecordToRow(record) {
  return {
    id: record.id,
    case_name: record.caseName,
    notes: record.notes,
    provider: record.provider,
    created_by_username: record.createdBy.username,
    created_by_display_name: record.createdBy.displayName,
    created_by_role: record.createdBy.role,
    updated_by_username: record.updatedBy.username,
    updated_by_display_name: record.updatedBy.displayName,
    updated_by_role: record.updatedBy.role,
    recommended_decision: record.summary.recommendedDecision,
    blocker_count: record.summary.blockerCount,
    unresolved_count: record.summary.unresolvedCount,
    mandatory_pass_count: record.summary.mandatoryPassCount,
    total_mandatory_count: record.summary.totalMandatoryCount,
    review_data: record.reviewData,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

export function isDatabaseConfigured() {
  return usingPostgres();
}

export function getStorageLabel() {
  return usingPostgres() ? "PostgreSQL" : "In-memory development store";
}

export async function listReviewCases(user) {
  if (!usingPostgres()) {
    return Array.from(memoryStore.values())
      .filter((record) => hasCaseAccess(memoryRecordToRow(record), user))
      .map((record) => toCaseSummary(memoryRecordToRow(record)))
      .sort((left, right) => {
        const rankDiff =
          workflowRank(left.workflow.status) - workflowRank(right.workflow.status);
        if (rankDiff !== 0) return rankDiff;
        return right.updatedAt.localeCompare(left.updatedAt);
      });
  }

  await ensurePostgresSchema();

  const query =
    user.role === "expert"
      ? {
          text: `
            SELECT *
            FROM review_cases
            ORDER BY updated_at DESC
            LIMIT 200
          `,
          values: [],
        }
      : {
          text: `
            SELECT *
            FROM review_cases
            WHERE created_by_username = $1
            ORDER BY updated_at DESC
            LIMIT 200
          `,
          values: [user.username],
        };

  const result = await getPool().query(query.text, query.values);
  return result.rows.map(toCaseSummary).sort((left, right) => {
    const rankDiff =
      workflowRank(left.workflow.status) - workflowRank(right.workflow.status);
    if (rankDiff !== 0) return rankDiff;
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

export async function getReviewCase(caseId, user) {
  if (!caseId) return null;

  if (!usingPostgres()) {
    const record = memoryStore.get(caseId);
    if (!record || !hasCaseAccess(memoryRecordToRow(record), user)) {
      return null;
    }

    return {
      ...record.reviewData,
      businessName: record.reviewData.businessName || record.reviewData.caseName || record.caseName,
      workflow: normalizeWorkflow(record.reviewData.workflow),
      caseId: record.id,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  await ensurePostgresSchema();
  const result = await getPool().query(
    `
      SELECT *
      FROM review_cases
      WHERE id = $1
      LIMIT 1
    `,
    [caseId],
  );
  const record = result.rows[0];

  if (!record || !hasCaseAccess(record, user)) {
    return null;
  }

  return {
    ...record.review_data,
    businessName:
      record.review_data?.businessName || record.review_data?.caseName || record.case_name,
    workflow: normalizeWorkflow(record.review_data?.workflow),
    caseId: record.id,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export async function saveReviewCase({
  caseId,
  caseName,
  notes,
  provider,
  actor,
  reviewData,
}) {
  const now = new Date().toISOString();
  const id = caseId || randomUUID();
  const summary = reviewData.summary ?? {
    recommendedDecision: "待人工复核",
    blockerCount: 0,
    unresolvedCount: 0,
    mandatoryPassCount: 0,
    totalMandatoryCount: 0,
    overview: "",
  };

  if (!usingPostgres()) {
    const existing = memoryStore.get(id);
    const createdBy = existing?.createdBy ?? actor;
    const createdAt = existing?.createdAt ?? now;
    const record = {
      id,
      caseName,
      notes,
      provider,
      createdBy,
      updatedBy: actor,
      summary,
      reviewData: {
        ...reviewData,
        caseId: id,
      },
      createdAt,
      updatedAt: now,
    };
    memoryStore.set(id, record);

    return {
      caseId: id,
      createdAt,
      updatedAt: now,
    };
  }

  await ensurePostgresSchema();
  const existing = await getPool().query(
    `
      SELECT id, created_by_username, created_by_display_name, created_by_role, created_at
      FROM review_cases
      WHERE id = $1
      LIMIT 1
    `,
    [id],
  );
  const existingRow = existing.rows[0];

  if (existingRow) {
    const result = await getPool().query(
      `
        UPDATE review_cases
        SET
          case_name = $2,
          notes = $3,
          provider = $4,
          updated_by_username = $5,
          updated_by_display_name = $6,
          updated_by_role = $7,
          recommended_decision = $8,
          blocker_count = $9,
          unresolved_count = $10,
          mandatory_pass_count = $11,
          total_mandatory_count = $12,
          review_data = $13::jsonb,
          updated_at = $14::timestamptz
        WHERE id = $1
        RETURNING created_at, updated_at
      `,
      [
        id,
        caseName,
        notes,
        provider,
        actor.username,
        actor.displayName,
        actor.role,
        summary.recommendedDecision,
        summary.blockerCount,
        summary.unresolvedCount,
        summary.mandatoryPassCount,
        summary.totalMandatoryCount,
        JSON.stringify({
          ...reviewData,
          caseId: id,
        }),
        now,
      ],
    );

    return {
      caseId: id,
      createdAt: result.rows[0]?.created_at ?? existingRow.created_at,
      updatedAt: result.rows[0]?.updated_at ?? now,
    };
  }

  const result = await getPool().query(
    `
      INSERT INTO review_cases (
        id,
        case_name,
        notes,
        provider,
        created_by_username,
        created_by_display_name,
        created_by_role,
        updated_by_username,
        updated_by_display_name,
        updated_by_role,
        recommended_decision,
        blocker_count,
        unresolved_count,
        mandatory_pass_count,
        total_mandatory_count,
        review_data,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $5, $6, $7,
        $8, $9, $10, $11, $12,
        $13::jsonb,
        $14::timestamptz,
        $14::timestamptz
      )
      RETURNING created_at, updated_at
    `,
    [
      id,
      caseName,
      notes,
      provider,
      actor.username,
      actor.displayName,
      actor.role,
      summary.recommendedDecision,
      summary.blockerCount,
      summary.unresolvedCount,
      summary.mandatoryPassCount,
      summary.totalMandatoryCount,
      JSON.stringify({
        ...reviewData,
        caseId: id,
      }),
      now,
    ],
  );

  return {
    caseId: id,
    createdAt: result.rows[0]?.created_at ?? now,
    updatedAt: result.rows[0]?.updated_at ?? now,
  };
}
