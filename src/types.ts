export type ReviewStatus =
  | "pending"
  | "pass"
  | "fail"
  | "insufficient_evidence"
  | "manual_review_required";

export type AuthRole = "operator" | "expert";

export type AuthUser = {
  username: string;
  displayName: string;
  role: AuthRole;
};

export type ReviewWorkflowStatus =
  | "draft"
  | "pending_expert_review"
  | "expert_reviewed";

export type ReviewWorkflow = {
  status: ReviewWorkflowStatus;
  submittedToExpertAt?: string;
  submittedToExpertBy?: AuthUser;
  expertReviewedAt?: string;
  expertReviewedBy?: AuthUser;
};

export type ChecklistRecord = {
  row_index: number;
  category: string;
  code: string;
  requirement: string;
  mandatory: boolean;
  example_status: string;
};

export type AnalysisEvidence = {
  id: string;
  fileName: string;
  mimeType: string;
  extractedText: string;
  summary: string;
  source: "ocr" | "document" | "text";
  linkedCodes: string[];
  globalEvidence: boolean;
  namingHint: string;
};

export type UploadedObject = {
  fileName: string;
  mimeType: string;
  size: number;
  objectKey: string;
};

export type ReviewItemResult = {
  code: string;
  status: ReviewStatus;
  confidence: number;
  rationale: string;
  basis: string[];
  remediation: string;
  referenceMethod: string;
  evidenceFiles: string[];
  nextAction: string;
};

export type AnalysisResponse = {
  caseId: string;
  createdAt?: string;
  updatedAt?: string;
  provider: string;
  businessName: string;
  caseName: string;
  notes?: string;
  actor?: AuthUser;
  workflow?: ReviewWorkflow;
  uploadedFiles?: UploadedObject[];
  summary: {
    recommendedDecision: string;
    blockerCount: number;
    unresolvedCount: number;
    mandatoryPassCount: number;
    totalMandatoryCount: number;
    overview: string;
  };
  evidences: AnalysisEvidence[];
  items: ReviewItemResult[];
};

export type CaseSummary = {
  caseId: string;
  businessName: string;
  caseName: string;
  workflow: ReviewWorkflow;
  recommendedDecision: string;
  blockerCount: number;
  unresolvedCount: number;
  mandatoryPassCount: number;
  totalMandatoryCount: number;
  createdBy: AuthUser;
  updatedBy: AuthUser;
  createdAt: string;
  updatedAt: string;
};
