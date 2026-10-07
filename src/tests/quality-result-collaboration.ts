import { SampleChainApplication } from '../app.js';
import { DomainError } from '../domain/errors.js';
import type { AnalysisBatch, InstrumentRun, ResultRevision } from '../domain/types.js';

let failures = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? `  ${error.message}` : `  ${String(error)}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`assertion failed: ${message} (expected ${String(expected)}, got ${String(actual)})`);
}

function expectDomainError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw new Error(`expected domain error ${code}, got ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`expected domain error ${code}, but no error was thrown`);
}

interface Seed {
  tenantId: string;
  projectId: string;
  batch: AnalysisBatch;
  run: InstrumentRun;
  rev1: ResultRevision;
  hash1: string;
  aliquotId: string;
}

function seedBatchWithResult(app: SampleChainApplication, label: string): Seed {
  const tenantId = 'tenant_test';
  const projectId = `project_${label}`;
  const sealed = app.sampling.createSealedSample({
    tenantId,
    projectId,
    collectorId: 'collector_01',
    protocolVersion: 'water-v3',
    medium: 'WATER',
    collectedAt: '2026-10-06T08:00:00.000Z',
    location: { latitude: 31.23, longitude: 121.47, siteCode: 'SITE-01' },
    preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
    clientDeviceId: 'device_01',
    clientSequence: 1,
    containerBarcode: `CNT-${label}`,
    sealCode: `SEAL-${label}`,
    totalVolumeMl: 100,
  });
  const transfer = app.custody.handOver({
    tenantId,
    projectId,
    containerId: sealed.container.id,
    fromHolderId: 'collector_01',
    toHolderId: 'courier_01',
    fromLocation: 'SITE-01',
    toLocation: 'LAB-01',
    handedOverAt: '2026-10-06T08:30:00.000Z',
    temperatureCelsius: 5,
    sealStatus: 'INTACT',
    clientOperationId: `handover-${label}`,
  });
  app.custody.confirmReceipt(transfer.id, { receiverId: 'courier_01', receivedAt: '2026-10-06T10:00:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT' });
  app.receiving.receive({ tenantId, projectId, containerId: sealed.container.id, receivedBy: 'lab_01', receivedAt: '2026-10-06T10:15:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT', decision: 'ACCEPTED', clientOperationId: `receive-${label}` });
  const aliquots = app.aliquots.createMany({ tenantId, projectId, parentContainerId: sealed.container.id, protocolVersion: 'water-v3', createdBy: 'analyst_01', operationId: `aliquot-${label}`, items: [{ barcode: `ALQ-${label}-1`, volumeMl: 20, unit: 'ML' }] });
  const aliquot = aliquots[0];
  assert(aliquot, 'seed aliquot created');
  const batch = app.batches.create({ tenantId, projectId, protocolVersion: 'water-v3', instrumentType: 'ICP-MS', requiredControls: [], createdBy: 'analyst_01' });
  app.batches.addAliquot(batch.id, aliquot.id);
  app.batches.markReady(batch.id);
  app.batches.start(batch.id, '2026-10-06T11:00:00.000Z');
  const run = app.results.registerRun({ tenantId, projectId, batchId: batch.id, externalRunId: `RUN-${label}-1`, rawFileHash: `raw-${label}-1`, instrumentSoftwareVersion: 'instrument-7.2', startedAt: '2026-10-06T11:10:00.000Z' });
  app.results.completeRun(run.id, '2026-10-06T12:00:00.000Z', 'COMPLETED');
  const hash1 = `hash-${label}-rev1`;
  const rev1 = app.results.ingestRevision({ tenantId, projectId, batchId: batch.id, runId: run.id, aliquotId: aliquot.id, analyte: 'lead', value: 0.12, unit: 'mg/L', detectionLimit: 0.01, qualityFlags: [], instrumentSoftwareVersion: 'instrument-7.2', contentHash: hash1 });
  return { tenantId, projectId, batch, run, rev1, hash1, aliquotId: aliquot.id };
}

function ingest(app: SampleChainApplication, ctx: Seed, runId: string, contentHash: string, value: number): ResultRevision {
  return app.results.ingestRevision({ tenantId: ctx.tenantId, projectId: ctx.projectId, batchId: ctx.batch.id, runId, aliquotId: ctx.aliquotId, analyte: 'lead', value, unit: 'mg/L', detectionLimit: 0.01, qualityFlags: [], instrumentSoftwareVersion: 'instrument-7.2', contentHash });
}

// 场景一+二：退回与上传并发、旧回执重试、旧内容重传、批准后退回、重复批准、证据包前后状态
{
  const app = new SampleChainApplication();
  const ctx = seedBatchWithResult(app, 'main');
  const { tenantId, projectId, batch, rev1, hash1 } = ctx;
  const hash2 = 'hash-main-rev2';

  test('退回与上传并发：退回结论绑定批次版本与结果修订，新修订重开批次', () => {
    const versionBeforeDecide = batch.version;
    const retest = app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId: rev1.id, decision: 'RETEST_REQUIRED', reason: 'peak shape out of tolerance', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01', clientOperationId: 'op-retest-1', expectedRevision: 1, expectedContentHash: hash1 });
    assertEqual(retest.batchVersion, versionBeforeDecide, 'decision binds the batch version at review time');
    assertEqual(retest.resultRevision, 1, 'decision binds the reviewed result revision');
    assertEqual(retest.resultContentHash, hash1, 'decision binds the reviewed content fingerprint');
    assertEqual(batch.status, 'REJECTED', 'retest return rejects the batch');

    const rev2 = ingest(app, ctx, ctx.run.id, hash2, 0.09);
    assertEqual(rev2.revisionNumber, 2, 'new upload becomes revision 2');
    assertEqual(rev2.status, 'CURRENT', 'new revision is current');
    assertEqual(rev1.status, 'SUPERSEDED', 'old revision is superseded');
    assertEqual(batch.status, 'RESULTS_PENDING', 'batch reopens for review after the new revision');

    const approve = app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId: rev2.id, decision: 'APPROVED', reason: 'retest within limits', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01', clientOperationId: 'op-approve-2' });
    assertEqual(approve.resultRevision, 2, 'approval binds revision 2');
    const approved = app.quality.approveBatch(batch.id, 'reviewer_01');
    assertEqual(approved.status, 'APPROVED', 'batch approved after retest cycle');
    assertEqual(approved.approvedVersion, approved.version, 'approval binds the batch version');
    assert(JSON.stringify(approved.approvedResultIds) === JSON.stringify([rev2.id]), 'approval binds the exact approved result revisions');
  });

  test('旧结果重传不能逆转当前值：旧内容回放返回原修订', () => {
    const resultCountBefore = app.store.results.size;
    const replayed = ingest(app, ctx, ctx.run.id, hash1, 0.12);
    assertEqual(replayed.id, rev1.id, 're-upload of old content returns the original revision');
    assertEqual(replayed.status, 'SUPERSEDED', 'replayed revision stays superseded');
    assertEqual(app.store.results.size, resultCountBefore, 'no new revision is created for old content');
    const current = [...app.store.results.values()].find((result) => result.batchId === batch.id && result.status === 'CURRENT');
    assert(current, 'a current revision exists');
    assertEqual(current.contentHash, hash2, 'current revision still holds the new content');
  });

  test('旧回执重试：迟到回执复用既有结论，不能逆转当前结果', () => {
    const qualityBefore = app.store.quality.size;
    const auditBefore = app.store.audit.length;
    const outboxBefore = app.store.outbox.length;
    const replay = app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId: rev1.id, decision: 'RETEST_REQUIRED', reason: 'peak shape out of tolerance', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01', clientOperationId: 'op-retest-1', expectedRevision: 1, expectedContentHash: hash1 });
    assertEqual(replay.decision, 'RETEST_REQUIRED', 'replay returns the original conclusion');
    assertEqual(app.store.quality.size, qualityBefore, 'replay creates no new decision');
    assertEqual(app.store.audit.length, auditBefore, 'replay writes no audit');
    assertEqual(app.store.outbox.length, outboxBefore, 'replay writes no outbox message');
    assertEqual(batch.status, 'APPROVED', 'late receipt cannot reverse the approved batch');
    const current = [...app.store.results.values()].find((result) => result.batchId === batch.id && result.status === 'CURRENT');
    assert(current, 'current revision exists');
    assertEqual(current.contentHash, hash2, 'late receipt cannot reverse the current result');

    const legacyRetry = app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId: rev1.id, decision: 'RETEST_REQUIRED', reason: 'peak shape out of tolerance', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01' });
    assertEqual(legacyRetry.id, replay.id, 'retry without operation id reuses the same conclusion');
    assertEqual(app.store.quality.size, qualityBefore, 'legacy retry creates no new decision');
    assertEqual(batch.status, 'APPROVED', 'batch remains approved');
  });

  test('批准后退回：已结批次不接受新退回，重复批准复用既有结论', () => {
    const approvedVersion = batch.approvedVersion;
    const approvedAudits = app.store.audit.filter((entry) => entry.action === 'batch.approved').length;
    const approvedOutbox = app.store.outbox.filter((entry) => entry.topic === 'batch.approved').length;
    const again = app.quality.approveBatch(batch.id, 'reviewer_01');
    assertEqual(again.approvedVersion, approvedVersion, 'repeated approval reuses the existing conclusion');
    assertEqual(app.store.audit.filter((entry) => entry.action === 'batch.approved').length, approvedAudits, 'repeated approval writes no new audit');
    assertEqual(app.store.outbox.filter((entry) => entry.topic === 'batch.approved').length, approvedOutbox, 'repeated approval writes no new outbox');

    const qualityBefore = app.store.quality.size;
    const lateReturn = app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId: [...app.store.results.values()].find((result) => result.batchId === batch.id && result.status === 'CURRENT')?.id ?? '', decision: 'RETEST_REQUIRED', reason: 'late return attempt', ruleVersion: 'quality-v2', reviewerId: 'reviewer_02', clientOperationId: 'op-late-return' });
    assertEqual(lateReturn.decision, 'APPROVED', 'late return after approval is suppressed to the existing conclusion');
    assertEqual(app.store.quality.size, qualityBefore, 'no new conclusion is recorded');
    assertEqual(batch.status, 'APPROVED', 'approved batch is not reversed');
    assert(app.store.audit.some((entry) => entry.action === 'quality.decision-suppressed'), 'suppressed return is audited');
  });

  test('证据包生成前后的状态变化：迟到回执与重试不改变证据内容', () => {
    const rev2 = [...app.store.results.values()].find((result) => result.batchId === batch.id && result.status === 'CURRENT');
    assert(rev2, 'current revision exists');
    const pack1 = app.evidence.generate({ tenantId, projectId, requestKey: 'evidence-k1' });
    assertEqual(pack1.status, 'READY', 'evidence package is ready');
    assert(JSON.stringify(pack1.sourceIds.resultIds) === JSON.stringify([rev2.id]), 'evidence contains only the current revision');
    const approveDecision = [...app.store.quality.values()].find((decision) => decision.resultId === rev2.id && decision.decision === 'APPROVED');
    assert(approveDecision, 'approval decision exists');
    assert(JSON.stringify(pack1.sourceIds.qualityDecisionIds) === JSON.stringify([approveDecision.id]), 'evidence contains only the bound approval');
    assert(!pack1.sourceIds.qualityDecisionIds.includes([...app.store.quality.values()].find((decision) => decision.decision === 'RETEST_REQUIRED')?.id ?? ''), 'returned old conclusion is not certified as current');

    const pack1Again = app.evidence.generate({ tenantId, projectId, requestKey: 'evidence-k1' });
    assertEqual(pack1Again.id, pack1.id, 'same request key reuses the package');
    assertEqual(pack1Again.version, pack1.version, 'regeneration does not mutate the package');

    app.evidence.freeze(pack1.id);
    const frozen = app.evidence.generate({ tenantId, projectId, requestKey: 'evidence-k1' });
    assertEqual(frozen.status, 'FROZEN', 'frozen package is returned as-is');

    // 生成之后的迟到重试与违规上传都不能改变已批准状态
    app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId: rev1.id, decision: 'RETEST_REQUIRED', reason: 'peak shape out of tolerance', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01', clientOperationId: 'op-retest-1', expectedRevision: 1, expectedContentHash: hash1 });
    expectDomainError(() => ingest(app, ctx, ctx.run.id, 'hash-main-rev3', 0.07), 'result.batch_closed');
    const replayCurrent = ingest(app, ctx, ctx.run.id, hash2, 0.09);
    assertEqual(replayCurrent.id, rev2.id, 'current content re-upload is a pure replay');
    assertEqual(batch.status, 'APPROVED', 'batch remains approved after late retries');

    const pack2 = app.evidence.generate({ tenantId, projectId, requestKey: 'evidence-k2' });
    assert(JSON.stringify(pack2.sourceIds.resultIds) === JSON.stringify(pack1.sourceIds.resultIds), 'late retries do not change the certified results');
    assert(JSON.stringify(pack2.sourceIds.qualityDecisionIds) === JSON.stringify(pack1.sourceIds.qualityDecisionIds), 'late retries do not change the certified conclusions');
    assertEqual([...app.store.results.values()].filter((result) => result.batchId === batch.id && result.status === 'CURRENT').length, 1, 'exactly one current revision remains');
  });
}

// 场景三：同版本不同指纹
{
  const app = new SampleChainApplication();
  const ctx = seedBatchWithResult(app, 'fingerprint');
  const { tenantId, projectId, batch, rev1, hash1 } = ctx;

  test('同版本不同指纹：指纹不符的回执被拒绝，重试载荷不符被判冲突', () => {
    expectDomainError(() => app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId: rev1.id, decision: 'APPROVED', reason: 'looks fine', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01', expectedContentHash: 'hash-tampered' }), 'quality.decision_conflict');
    expectDomainError(() => app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId: rev1.id, decision: 'APPROVED', reason: 'looks fine', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01', expectedRevision: 7 }), 'quality.result_not_current');
    assertEqual(app.store.quality.size, 0, 'conflicting receipts record nothing');

    const original = app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId: rev1.id, decision: 'RETEST_REQUIRED', reason: 'needs another run', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01', clientOperationId: 'op-fp-1', expectedContentHash: hash1 });
    expectDomainError(() => app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId: rev1.id, decision: 'RETEST_REQUIRED', reason: 'needs another run', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01', clientOperationId: 'op-fp-1', expectedContentHash: 'hash-tampered' }), 'quality.decision_conflict');
    expectDomainError(() => app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId: rev1.id, decision: 'APPROVED', reason: 'changed my mind', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01', clientOperationId: 'op-fp-1' }), 'quality.decision_conflict');
    const replay = app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId: rev1.id, decision: 'RETEST_REQUIRED', reason: 'needs another run', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01', clientOperationId: 'op-fp-1', expectedContentHash: hash1 });
    assertEqual(replay.id, original.id, 'identical retry reuses the original conclusion');
    assertEqual(app.store.quality.size, 1, 'conflicting retries record nothing');
  });
}

// 场景四：退回后通过新运行重测的完整闭环
{
  const app = new SampleChainApplication();
  const ctx = seedBatchWithResult(app, 'retest-run');
  const { tenantId, projectId, batch, rev1 } = ctx;

  test('退回与上传并发：退回批次可注册重测运行并完成重审', () => {
    app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId: rev1.id, decision: 'RETEST_REQUIRED', reason: 'instrument drift', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01', clientOperationId: 'op-rr-1' });
    assertEqual(batch.status, 'REJECTED', 'batch rejected for retest');
    const rerun = app.results.registerRun({ tenantId, projectId, batchId: batch.id, externalRunId: 'RUN-retest-run-2', rawFileHash: 'raw-retest-run-2', instrumentSoftwareVersion: 'instrument-7.3', startedAt: '2026-10-06T13:00:00.000Z' });
    assertEqual(batch.status, 'RESULTS_PENDING', 'registering the retest run reopens the batch');
    app.results.completeRun(rerun.id, '2026-10-06T14:00:00.000Z', 'COMPLETED');
    const rev2 = ingest(app, ctx, rerun.id, 'hash-retest-run-rev2', 0.1);
    assertEqual(rev2.revisionNumber, 2, 'retest result becomes revision 2');
    app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId: rev2.id, decision: 'APPROVED', reason: 'retest acceptable', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01', clientOperationId: 'op-rr-2' });
    const approved = app.quality.approveBatch(batch.id, 'reviewer_01');
    assertEqual(approved.status, 'APPROVED', 'batch approved after the retest cycle');
    assert(JSON.stringify(approved.approvedResultIds) === JSON.stringify([rev2.id]), 'approval binds the retest revision');
  });
}

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  throw new Error('quality/result collaboration tests failed');
}
console.log('all quality/result collaboration tests passed');
