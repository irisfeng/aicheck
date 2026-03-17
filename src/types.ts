export type ReviewStatus =
  | "pending"
  | "pass"
  | "fail"
  | "insufficient_evidence"
  | "manual_review_required";

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
};

export type ReviewItemResult = {
  code: string;
  status: ReviewStatus;
  confidence: number;
  rationale: string;
  evidenceFiles: string[];
  nextAction: string;
};

export type AnalysisResponse = {
  provider: string;
  caseName: string;
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
