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
}

export class QualityService {
  constructor(private readonly store: Store) {}

  decide(input: DecideInput): QualityDecision {
    this.validateDecisionInput(input);
    const result = assertFound(this.store.results.get(input.resultId), 'quality.result_not_found', 'result not found');
    const batch = assertFound(this.store.batches.get(input.batchId), 'quality.batch_not_found', 'batch not found');
    assertCondition(result.batchId === batch.id && result.projectId === input.projectId && batch.projectId === input.projectId, 'scope.forbidden', 'quality decision is outside the requested project');

    // an exact replay of a recorded review operation reuses its conclusion,
    // even when the receipt arrives late from another terminal.
    if (input.clientOperationId !== undefined) {
      const replay = [...this.store.quality.values()].find((item) => item.projectId === input.projectId && item.clientOperationId === input.clientOperationId);
      if (replay) {
        assertCondition(replay.resultId === result.id && replay.batchId === batch.id && replay.decision === input.decision && replay.reviewerId === input.reviewerId && replay.ruleVersion === input.ruleVersion, 'quality.decision_conflict', 'same review operation was submitted with a different payload');
        return replay;
      }
    }

    // the same conclusion already recorded for this revision is reused on repeat.
    const previous = [...this.store.quality.values()]
      .filter((decision) => decision.resultId === result.id && decision.projectId === input.projectId)
      .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
    if (previous && previous.decision === input.decision) return previous;

    // a genuinely new conclusion may only target the current revision of a
    // reviewable batch; late receipts must not reverse approved or superseded state.
    assertCondition(batch.status !== 'APPROVED', 'quality.batch_already_approved', 'batch is already approved and cannot be re-reviewed');
    assertCondition(batch.status !== 'CANCELLED', 'quality.batch_not_reviewable', 'cancelled batch cannot be reviewed');
    assertCondition(result.status === 'CURRENT', 'quality.result_not_current', 'only the current result revision can be reviewed');

    // first conclusion wins for a revision; a later dissenting one is suppressed.
    if (previous) {
      this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'quality.decision-suppressed', entity: 'result', entityId: result.id, metadata: { previousDecision: previous.decision, requestedDecision: input.decision, ruleVersion: input.ruleVersion } });
      return previous;
    }

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
      batchVersion: batch.version,
      resultRevisionNumber: result.revisionNumber,
      ...(input.clientOperationId === undefined ? {} : { clientOperationId: input.clientOperationId }),
      decidedAt: this.store.now(),
      version: 1,
    };
    this.store.quality.set(decision.id, decision);
    if (input.decision === 'RETEST_REQUIRED' || input.decision === 'REJECTED') {
      batch.status = 'REJECTED';
      batch.rejectionKind = input.decision;
      batch.version += 1;
    }
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: `quality.${input.decision.toLowerCase()}`, entity: 'result', entityId: result.id, metadata: { batchId: batch.id, batchVersion: decision.batchVersion, resultRevisionNumber: decision.resultRevisionNumber, ruleVersion: input.ruleVersion, reviewerId: input.reviewerId } });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'quality.decision-recorded', aggregateId: result.id, payload: JSON.stringify({ decisionId: decision.id, resultId: result.id, decision: input.decision, batchVersion: decision.batchVersion, resultRevisionNumber: decision.resultRevisionNumber }) });
    return decision;
  }

  approveBatch(batchId: string, reviewerId: string): AnalysisBatch {
    const batch = assertFound(this.store.batches.get(batchId), 'quality.batch_not_found', 'batch not found');
    // repeated approval reuses the existing conclusion instead of recording a new one.
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
      const latest = [...this.store.quality.values()]
        .filter((decision) => decision.resultId === result.id)
        .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
      assertCondition(latest !== undefined && latest.decision === 'APPROVED', 'quality.result_unapproved', `result ${result.id} has not been approved`);
    }
    batch.status = 'APPROVED';
    delete batch.rejectionKind;
    batch.approvedAt = this.store.now();
    batch.version += 1;
    this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.approved', entity: 'batch', entityId: batch.id, metadata: { reviewerId, resultCount: currentResults.length } });
    this.store.addOutbox({ tenantId: batch.tenantId, projectId: batch.projectId, topic: 'batch.approved', aggregateId: batch.id, payload: JSON.stringify({ batchId: batch.id, reviewerId }) });
    return batch;
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
