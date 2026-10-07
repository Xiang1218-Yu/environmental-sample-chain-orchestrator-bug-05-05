import type { AnalysisBatch, InstrumentRun, ResultRevision } from '../domain/types.js';
import { assertCondition, assertFound } from '../domain/errors.js';
import { Store } from '../store/store.js';

export interface RegisterRunInput {
  tenantId: string;
  projectId: string;
  batchId: string;
  externalRunId: string;
  rawFileHash: string;
  instrumentSoftwareVersion: string;
  startedAt: string;
}

export interface ResultInput {
  tenantId: string;
  projectId: string;
  batchId: string;
  runId: string;
  aliquotId?: string;
  controlKind?: 'BLANK' | 'CALIBRATION' | 'POSITIVE_CONTROL' | 'NEGATIVE_CONTROL';
  analyte: string;
  value: number;
  unit: string;
  detectionLimit: number;
  qualityFlags: string[];
  instrumentSoftwareVersion: string;
  contentHash: string;
  revisionNumber: number;
}

export class ResultService {
  constructor(private readonly store: Store) {}

  registerRun(input: RegisterRunInput): InstrumentRun {
    const existing = [...this.store.runs.values()].find((run) => run.projectId === input.projectId && run.externalRunId === input.externalRunId);
    if (existing) {
      assertCondition(existing.rawFileHash === input.rawFileHash, 'result.run_conflict', 'external run id has a different raw file');
      return existing;
    }
    const batch = assertFound(this.store.batches.get(input.batchId), 'batch.not_found', 'batch not found');
    assertCondition(batch.tenantId === input.tenantId && batch.projectId === input.projectId, 'scope.forbidden', 'batch is outside the requested project');
    this.assertBatchAcceptsResults(batch);
    const run: InstrumentRun = { id: this.store.nextId('run'), tenantId: input.tenantId, projectId: input.projectId, batchId: input.batchId, externalRunId: input.externalRunId, rawFileHash: input.rawFileHash, instrumentSoftwareVersion: input.instrumentSoftwareVersion, startedAt: input.startedAt, status: 'REGISTERED', version: 1 };
    this.store.runs.set(run.id, run);
    batch.status = 'RESULTS_PENDING';
    batch.version += 1;
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'instrument.run_registered', entity: 'run', entityId: run.id, metadata: { batchId: batch.id, externalRunId: input.externalRunId } });
    return run;
  }

  completeRun(runId: string, completedAt: string, status: 'COMPLETED' | 'FAILED'): InstrumentRun {
    const run = assertFound(this.store.runs.get(runId), 'result.run_not_found', 'instrument run not found');
    assertCondition(run.status === 'REGISTERED' || run.status === 'RUNNING', 'result.run_closed', 'instrument run is already closed');
    run.status = status;
    run.completedAt = completedAt;
    run.version += 1;
    return run;
  }

  ingestRevision(input: ResultInput): ResultRevision {
    const run = assertFound(this.store.runs.get(input.runId), 'result.run_not_found', 'instrument run not found');
    const batch = assertFound(this.store.batches.get(input.batchId), 'batch.not_found', 'batch not found');
    assertCondition(run.batchId === batch.id && run.projectId === input.projectId && batch.projectId === input.projectId, 'scope.forbidden', 'result does not belong to the requested batch');
    assertCondition(Number.isInteger(input.revisionNumber) && input.revisionNumber >= 1, 'result.revision_invalid', 'revision number must be a positive integer');
    const revisions = this.findRevisions(input);
    const sameNumber = revisions.find((result) => result.revisionNumber === input.revisionNumber);
    if (sameNumber) {
      // a retried upload of an already recorded revision: identical fingerprint replays
      // the stored revision without resurrecting it, a different fingerprint conflicts.
      assertCondition(sameNumber.contentHash === input.contentHash, 'result.revision_conflict', 'same revision number was uploaded with a different fingerprint');
      return sameNumber;
    }
    this.assertBatchAcceptsResults(batch);
    const latest = revisions[revisions.length - 1];
    const expected = (latest?.revisionNumber ?? 0) + 1;
    assertCondition(input.revisionNumber === expected, 'result.revision_sequence', `expected revision ${expected} for this result`);
    const current = revisions.find((result) => result.status === 'CURRENT');
    return this.createRevision(input, input.revisionNumber, current?.id);
  }

  private assertBatchAcceptsResults(batch: AnalysisBatch): void {
    if (batch.status === 'REJECTED' && batch.rejectionKind === 'RETEST_REQUIRED') {
      // a retest upload reopens a batch that was sent back for retesting.
      batch.status = 'RESULTS_PENDING';
      delete batch.rejectionKind;
      batch.version += 1;
      this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.reopened', entity: 'batch', entityId: batch.id, metadata: { reason: 'retest_upload' } });
      return;
    }
    assertCondition(batch.status === 'RUNNING' || batch.status === 'RESULTS_PENDING' || batch.status === 'UNDER_REVIEW', 'result.batch_not_accepting', 'batch is not accepting instrument results in its current state');
  }

  private createRevision(input: ResultInput, revisionNumber: number, supersedesRevisionId?: string): ResultRevision {
    const result: ResultRevision = {
      id: this.store.nextId('result'),
      tenantId: input.tenantId,
      projectId: input.projectId,
      batchId: input.batchId,
      runId: input.runId,
      ...(input.aliquotId === undefined ? {} : { aliquotId: input.aliquotId }),
      ...(input.controlKind === undefined ? {} : { controlKind: input.controlKind }),
      analyte: input.analyte,
      value: input.value,
      unit: input.unit,
      detectionLimit: input.detectionLimit,
      qualityFlags: [...input.qualityFlags],
      instrumentSoftwareVersion: input.instrumentSoftwareVersion,
      contentHash: input.contentHash,
      revisionNumber,
      ...(supersedesRevisionId === undefined ? {} : { supersedesRevisionId }),
      status: 'CURRENT',
      createdAt: this.store.now(),
      version: 1,
    };
    if (supersedesRevisionId) {
      const prior = assertFound(this.store.results.get(supersedesRevisionId), 'result.previous_missing', 'previous result revision not found');
      prior.status = 'SUPERSEDED';
      prior.version += 1;
    }
    this.store.results.set(result.id, result);
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'result.revision_created', entity: 'result', entityId: result.id, metadata: { batchId: input.batchId, revisionNumber, analyte: input.analyte } });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'result.revision-created', aggregateId: result.id, payload: JSON.stringify({ resultId: result.id, batchId: input.batchId, revisionNumber }) });
    return result;
  }

  private findRevisions(input: ResultInput): ResultRevision[] {
    return [...this.store.results.values()]
      .filter((result) => result.projectId === input.projectId && result.batchId === input.batchId && result.analyte === input.analyte && result.aliquotId === input.aliquotId && result.controlKind === input.controlKind)
      .sort((a, b) => a.revisionNumber - b.revisionNumber);
  }
}
