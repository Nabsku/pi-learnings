export type LearningStatus = "pending" | "applied" | "rejected";
export type LearningClassification = "verification_overclaim" | "scope_drift" | "unsafe_edit" | "wrong_tool" | "context_miss" | "stale_data" | "transient" | "other";
export type LearningTargetKind = "repo-agents" | "global-agents" | "global-system" | "workflow-rule" | "note-only";

export type LearningSource = {
  selector: "manual" | "last" | "turn-id";
  turnId?: string;
  role: "assistant" | "tool" | "user" | "unknown";
  excerpt: string;
};

export type SimilarLearningCandidate = {
  id: string;
  path: string;
  section: string;
  line?: number;
  existingText: string;
  score: number;
  reason: string;
};

export type LearningDraft = {
  section: string;
  proposedText: string;
  rationale: string;
  duplicateCheck: {
    searched: string[];
    similarExistingRule: string | null;
    similar?: SimilarLearningCandidate[];
    suggestedAction?: "append" | "update" | "reject";
  };
  risk: "low" | "medium" | "high";
};

export type LearningRecord = {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  root: string;
  source: LearningSource;
  issue: { description: string; desiredFutureBehavior?: string };
  classification: LearningClassification;
  recommendedTarget: { kind: LearningTargetKind; path: string };
  draft?: LearningDraft;
  status: LearningStatus;
  rejectionReason?: string;
  appliedAt?: string;
};
