import type { AnalysisBatch, QualityDecision, QualityDecisionType } from '../domain/types.js';
import { assertCondition, assertFound } from '../domain/errors.js';
import { Store } from '../store/store.js';

export interface DecideInput {
  tenantId: string;
  projectId: string;
  batchId: string;
  resultId: string;
  decision: QualityDecisionType;
  reason: string;
  ruleVersion: string;
  reviewerId: string;
  clientOperationId?: string;
  expectedRevision?: number;
  expectedContentHash?: string;
}

export class QualityService {
  constructor(private readonly store: Store) {}

  decide(input: DecideInput): QualityDecision {
    this.validateDecisionInput(input);
    const result = assertFound(this.store.results.get(input.resultId), 'quality.result_not_found', 'result not found');
    const batch = assertFound(this.store.batches.get(input.batchId), 'quality.batch_not_found', 'batch not found');
    assertCondition(result.batchId === batch.id && result.projectId === input.projectId && batch.projectId === input.projectId, 'scope.forbidden', 'quality decision is outside the requested project');
    // idempotent replay: a retried receipt reuses the conclusion it already produced,
    // even if the reviewed revision has since been superseded or the batch concluded.
    const replayed = this.findReplay(input);
    if (replayed) return replayed;
    const previous = this.findPreviousDecision(input, result.id);
    if (previous) {
      if (previous.decision !== input.decision) {
        this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'quality.decision-suppressed', entity: 'result', entityId: result.id, metadata: { previousDecision: previous.decision, requestedDecision: input.decision, ruleVersion: input.ruleVersion } });
      }
      return previous;
    }
    // the receipt must describe the exact revision and fingerprint the reviewer saw.
    if (input.expectedContentHash !== undefined) {
      assertCondition(result.contentHash === input.expectedContentHash, 'quality.decision_conflict', 'reviewed fingerprint does not match the stored result revision');
    }
    if (input.expectedRevision !== undefined) {
      assertCondition(result.revisionNumber === input.expectedRevision, 'quality.result_not_current', 'result revision moved on before the receipt arrived');
    }
    assertCondition(result.status === 'CURRENT', 'quality.result_not_current', 'only the current result revision can be reviewed');
    // a concluded batch cannot be reversed by a late receipt.
    assertCondition(batch.status !== 'APPROVED' && batch.status !== 'CANCELLED', 'quality.batch_not_reviewable', 'batch is already concluded and cannot be reversed');
    const decision: QualityDecision = {
      id: this.store.nextId('quality'),
      tenantId: input.tenantId,
      projectId: input.projectId,
      batchId: input.batchId,
      resultId: input.resultId,
      decision: input.decision,
      reason: input.reason,
      ruleVersion: input.ruleVersion,
      reviewerId: input.reviewerId,
      decidedAt: this.store.now(),
      batchVersion: batch.version,
      resultRevision: result.revisionNumber,
      resultContentHash: result.contentHash,
      ...(input.clientOperationId === undefined ? {} : { clientOperationId: input.clientOperationId }),
      version: 1,
    };
    this.store.quality.set(decision.id, decision);
    if ((input.decision === 'RETEST_REQUIRED' || input.decision === 'REJECTED') && batch.status !== 'REJECTED') {
      batch.status = 'REJECTED';
      batch.version += 1;
    }
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: `quality.${input.decision.toLowerCase()}`, entity: 'result', entityId: result.id, metadata: { batchId: batch.id, batchVersion: decision.batchVersion, resultRevision: decision.resultRevision, ruleVersion: input.ruleVersion, reviewerId: input.reviewerId } });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'quality.decision-recorded', aggregateId: result.id, payload: JSON.stringify({ decisionId: decision.id, resultId: result.id, decision: input.decision, resultRevision: decision.resultRevision }) });
    return decision;
  }

  approveBatch(batchId: string, reviewerId: string): AnalysisBatch {
    const batch = assertFound(this.store.batches.get(batchId), 'quality.batch_not_found', 'batch not found');
    // repeated approval reuses the existing conclusion instead of piling up new ones.
    if (batch.status === 'APPROVED') return batch;
    assertCondition(batch.status === 'RESULTS_PENDING' || batch.status === 'UNDER_REVIEW', 'quality.batch_not_reviewable', 'batch is not ready for approval');
    const currentResults = [...this.store.results.values()].filter((result) => result.batchId === batch.id && result.status === 'CURRENT');
    assertCondition(currentResults.length > 0, 'quality.no_results', 'batch has no current results');
    const controlKinds = new Map<string, number>();
    for (const result of currentResults) {
      if (result.controlKind) controlKinds.set(result.controlKind, (controlKinds.get(result.controlKind) ?? 0) + 1);
    }
    for (const requirement of batch.requiredControls) {
      assertCondition((controlKinds.get(requirement.kind) ?? 0) >= requirement.minimumCount, 'quality.control_missing', `missing control: ${requirement.kind}`);
    }
    for (const result of currentResults) {
      const boundApproval = [...this.store.quality.values()].find((decision) => decision.resultId === result.id && decision.decision === 'APPROVED' && decision.resultRevision === result.revisionNumber && decision.resultContentHash === result.contentHash);
      assertCondition(Boolean(boundApproval), 'quality.result_unapproved', `result ${result.id} revision ${result.revisionNumber} has not been approved`);
    }
    batch.status = 'APPROVED';
    batch.approvedAt = this.store.now();
    batch.version += 1;
    batch.approvedVersion = batch.version;
    batch.approvedResultIds = currentResults.map((result) => result.id);
    this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.approved', entity: 'batch', entityId: batch.id, metadata: { reviewerId, resultCount: currentResults.length, approvedVersion: batch.approvedVersion } });
    this.store.addOutbox({ tenantId: batch.tenantId, projectId: batch.projectId, topic: 'batch.approved', aggregateId: batch.id, payload: JSON.stringify({ batchId: batch.id, reviewerId, approvedVersion: batch.approvedVersion }) });
    return batch;
  }

  private findReplay(input: DecideInput): QualityDecision | undefined {
    if (input.clientOperationId === undefined) return undefined;
    const existing = [...this.store.quality.values()].find((decision) => decision.projectId === input.projectId && decision.clientOperationId === input.clientOperationId);
    if (!existing) return undefined;
    const samePayload = existing.resultId === input.resultId
      && existing.decision === input.decision
      && existing.reason === input.reason
      && existing.ruleVersion === input.ruleVersion
      && existing.reviewerId === input.reviewerId
      && (input.expectedContentHash === undefined || input.expectedContentHash === existing.resultContentHash)
      && (input.expectedRevision === undefined || input.expectedRevision === existing.resultRevision);
    assertCondition(samePayload, 'quality.decision_conflict', 'same quality operation was submitted with a different payload');
    return existing;
  }

  private findPreviousDecision(input: DecideInput, resultId: string): QualityDecision | undefined {
    return [...this.store.quality.values()]
      .filter((decision) => decision.resultId === resultId && decision.projectId === input.projectId)
      .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
  }

  private validateDecisionInput(input: DecideInput): void {
    assertCondition(input.tenantId.length > 0 && input.projectId.length > 0, 'quality.invalid_scope', 'quality scope is required');
    assertCondition(input.reason.trim().length >= 3, 'quality.reason_required', 'quality reason is required');
    assertCondition(input.ruleVersion.trim().length > 0, 'quality.rule_required', 'rule version is required');
    assertCondition(input.reviewerId.trim().length > 0, 'quality.reviewer_required', 'reviewer is required');
    assertCondition(['APPROVED', 'REJECTED', 'RETEST_REQUIRED'].includes(input.decision), 'quality.invalid_decision', 'unknown quality decision');
    const recent = [...this.store.quality.values()].filter((item) => item.projectId === input.projectId && item.reviewerId === input.reviewerId);
    assertCondition(recent.length < 10000, 'quality.reviewer_quota', 'reviewer decision quota exceeded');
    const duplicateReason = recent.some((item) => item.resultId === input.resultId && item.reason === input.reason);
    if (duplicateReason) {
      assertCondition(input.ruleVersion.length > 0, 'quality.duplicate_without_rule', 'duplicate decision requires rule version');
    }
  }
}
