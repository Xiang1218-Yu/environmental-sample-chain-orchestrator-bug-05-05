import test from 'node:test';
import assert from 'node:assert/strict';
import { SampleChainApplication } from '../src/app.js';
import { DomainError } from '../src/domain/errors.js';
import type { ResultInput } from '../src/services/result-service.js';
import type { DecideInput } from '../src/services/quality-service.js';

const tenantId = 'tenant_test';
const projectId = 'project_test';

interface Chain {
  app: SampleChainApplication;
  batchId: string;
  runId: string;
  aliquotId: string;
}

function createChain(): Chain {
  const app = new SampleChainApplication();
  const sealed = app.sampling.createSealedSample({
    tenantId, projectId, collectorId: 'collector_01', protocolVersion: 'water-v3', medium: 'WATER',
    collectedAt: '2026-10-06T08:00:00.000Z',
    location: { latitude: 31.23, longitude: 121.47, siteCode: 'SITE-SH-01' },
    preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
    clientDeviceId: 'device_01', clientSequence: 1, containerBarcode: 'CNT-001', sealCode: 'SEAL-001', totalVolumeMl: 100,
  });
  const transfer = app.custody.handOver({
    tenantId, projectId, containerId: sealed.container.id, fromHolderId: 'collector_01', toHolderId: 'courier_01',
    fromLocation: 'SITE-SH-01', toLocation: 'LAB-SH-A', handedOverAt: '2026-10-06T08:30:00.000Z',
    temperatureCelsius: 5, sealStatus: 'INTACT', clientOperationId: 'handover-001',
  });
  app.custody.confirmReceipt(transfer.id, { receiverId: 'courier_01', receivedAt: '2026-10-06T10:00:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT' });
  app.receiving.receive({ tenantId, projectId, containerId: sealed.container.id, receivedBy: 'lab_01', receivedAt: '2026-10-06T10:15:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT', decision: 'ACCEPTED', clientOperationId: 'receive-001' });
  const aliquots = app.aliquots.createMany({ tenantId, projectId, parentContainerId: sealed.container.id, protocolVersion: 'water-v3', createdBy: 'analyst_01', operationId: 'aliquot-001', items: [{ barcode: 'ALQ-001', volumeMl: 20, unit: 'ML' }] });
  const aliquot = aliquots[0];
  assert.ok(aliquot);
  const batch = app.batches.create({ tenantId, projectId, protocolVersion: 'water-v3', instrumentType: 'ICP-MS', requiredControls: [], createdBy: 'analyst_01' });
  app.batches.addAliquot(batch.id, aliquot.id);
  app.batches.markReady(batch.id);
  app.batches.start(batch.id, '2026-10-06T11:00:00.000Z');
  const run = app.results.registerRun({ tenantId, projectId, batchId: batch.id, externalRunId: 'RUN-001', rawFileHash: 'raw-001', instrumentSoftwareVersion: 'instr-7.2', startedAt: '2026-10-06T11:10:00.000Z' });
  app.results.completeRun(run.id, '2026-10-06T12:00:00.000Z', 'COMPLETED');
  return { app, batchId: batch.id, runId: run.id, aliquotId: aliquot.id };
}

function resultInput(chain: Chain, overrides: Partial<ResultInput>): ResultInput {
  return {
    tenantId, projectId, batchId: chain.batchId, runId: chain.runId, aliquotId: chain.aliquotId,
    analyte: 'lead', value: 0.5, unit: 'mg/L', detectionLimit: 0.01, qualityFlags: [],
    instrumentSoftwareVersion: 'instr-7.2', contentHash: 'hash-rev1', revisionNumber: 1,
    ...overrides,
  };
}

function decideInput(chain: Chain, resultId: string, overrides: Partial<DecideInput>): DecideInput {
  return {
    tenantId, projectId, batchId: chain.batchId, resultId,
    decision: 'APPROVED', reason: 'within protocol limits', ruleVersion: 'q-v2', reviewerId: 'reviewer_01',
    ...overrides,
  };
}

function expectDomainError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof DomainError && error.code === code);
}

function currentResult(app: SampleChainApplication): { value: number; revisionNumber: number; status: string } {
  const current = [...app.store.results.values()].find((result) => result.analyte === 'lead' && result.status === 'CURRENT');
  assert.ok(current);
  return current;
}

test('退回与上传并发：重测回执与新修订不论先后顺序都收敛到一致状态', async () => {
  const chain = createChain();
  const { app, batchId } = chain;
  const rev1 = app.results.ingestRevision(resultInput(chain, { value: 0.5, contentHash: 'hash-rev1', revisionNumber: 1 }));

  // 退回与上传并发到达（通过事务互斥串行化，退回先落地）
  await Promise.all([
    app.store.transaction(() => app.quality.decide(decideInput(chain, rev1.id, { decision: 'RETEST_REQUIRED', reason: 'value above limit', clientOperationId: 'review-op-1' }))),
    app.store.transaction(() => app.results.ingestRevision(resultInput(chain, { value: 0.12, contentHash: 'hash-rev2', revisionNumber: 2 }))),
  ]);

  const batch = app.store.batches.get(batchId);
  assert.ok(batch);
  assert.equal(app.store.results.get(rev1.id)?.status, 'SUPERSEDED');
  assert.equal(currentResult(app).value, 0.12);
  // 批次被重测上传重新打开，而不是卡在 REJECTED
  assert.equal(batch.status, 'RESULTS_PENDING');
  assert.equal(batch.rejectionKind, undefined);
  // 退回结论仍然绑定到旧修订与当时的批次版本
  const decisions = [...app.store.quality.values()];
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.resultId, rev1.id);
  assert.equal(decisions[0]?.resultRevisionNumber, 1);
  assert.equal(typeof decisions[0]?.batchVersion, 'number');

  // 反向顺序：上传先落地，迟到的“新”退回回执不能逆转当前结果
  const reversed = createChain();
  const r1 = reversed.app.results.ingestRevision(resultInput(reversed, { value: 0.5, contentHash: 'hash-rev1', revisionNumber: 1 }));
  reversed.app.results.ingestRevision(resultInput(reversed, { value: 0.12, contentHash: 'hash-rev2', revisionNumber: 2 }));
  expectDomainError(
    () => reversed.app.quality.decide(decideInput(reversed, r1.id, { decision: 'RETEST_REQUIRED', reason: 'value above limit', clientOperationId: 'review-op-late' })),
    'quality.result_not_current',
  );
  assert.equal(currentResult(reversed.app).value, 0.12);
  assert.equal(reversed.app.store.batches.get(reversed.batchId)?.status, 'RESULTS_PENDING');
  assert.equal([...reversed.app.store.quality.values()].length, 0);
});

test('并发事务中失败的一侧回滚，不留下半截状态', async () => {
  const chain = createChain();
  const { app } = chain;
  const rev1 = app.results.ingestRevision(resultInput(chain, { revisionNumber: 1 }));
  const auditBefore = app.store.audit.length;

  await assert.rejects(
    app.store.transaction(() => {
      app.results.ingestRevision(resultInput(chain, { value: 0.12, contentHash: 'hash-rev2', revisionNumber: 2 }));
      throw new Error('simulated terminal failure');
    }),
  );
  assert.equal(app.store.results.get(rev1.id)?.status, 'CURRENT');
  assert.equal([...app.store.results.values()].length, 1);
  assert.equal(app.store.audit.length, auditBefore);
});

test('旧回执重试：相同复核操作复用既有结论，不产生副作用', () => {
  const chain = createChain();
  const { app, batchId } = chain;
  const rev1 = app.results.ingestRevision(resultInput(chain, { value: 0.5, contentHash: 'hash-rev1', revisionNumber: 1 }));
  const retest = app.quality.decide(decideInput(chain, rev1.id, { decision: 'RETEST_REQUIRED', reason: 'value above limit', clientOperationId: 'review-op-1' }));
  assert.equal(app.store.batches.get(batchId)?.status, 'REJECTED');
  assert.equal(app.store.batches.get(batchId)?.rejectionKind, 'RETEST_REQUIRED');

  // 新修订上传，批次重新打开
  const rev2 = app.results.ingestRevision(resultInput(chain, { value: 0.12, contentHash: 'hash-rev2', revisionNumber: 2 }));
  assert.equal(app.store.batches.get(batchId)?.status, 'RESULTS_PENDING');

  // 另一台终端重试同一张旧回执（带操作号）：复用结论，批次不被再次打回
  const batchVersionBefore = app.store.batches.get(batchId)?.version;
  const replay = app.quality.decide(decideInput(chain, rev1.id, { decision: 'RETEST_REQUIRED', reason: 'value above limit', clientOperationId: 'review-op-1' }));
  assert.equal(replay.id, retest.id);
  assert.equal(app.store.batches.get(batchId)?.status, 'RESULTS_PENDING');
  assert.equal(app.store.batches.get(batchId)?.version, batchVersionBefore);
  assert.equal([...app.store.quality.values()].length, 1);

  // 不带操作号的相同结论重试同样复用
  const repeated = app.quality.decide(decideInput(chain, rev1.id, { decision: 'RETEST_REQUIRED', reason: 'value above limit' }));
  assert.equal(repeated.id, retest.id);
  assert.equal([...app.store.quality.values()].length, 1);

  // 同一操作号携带不同结论：负载冲突
  expectDomainError(
    () => app.quality.decide(decideInput(chain, rev2.id, { decision: 'APPROVED', reason: 'different payload', clientOperationId: 'review-op-1' })),
    'quality.decision_conflict',
  );
});

test('同版本不同指纹：冲突检测、幂等重放与迟到旧上传', () => {
  const chain = createChain();
  const { app } = chain;
  const rev1 = app.results.ingestRevision(resultInput(chain, { value: 0.5, contentHash: 'hash-rev1', revisionNumber: 1 }));

  // 相同修订号 + 相同指纹：幂等重放，不产生新修订
  const replay = app.results.ingestRevision(resultInput(chain, { value: 0.5, contentHash: 'hash-rev1', revisionNumber: 1 }));
  assert.equal(replay.id, rev1.id);
  assert.equal([...app.store.results.values()].length, 1);

  // 相同修订号 + 不同指纹：冲突
  expectDomainError(
    () => app.results.ingestRevision(resultInput(chain, { value: 0.9, contentHash: 'hash-tampered', revisionNumber: 1 })),
    'result.revision_conflict',
  );

  // 跳号上传：序列校验
  expectDomainError(
    () => app.results.ingestRevision(resultInput(chain, { value: 0.9, contentHash: 'hash-rev3', revisionNumber: 3 })),
    'result.revision_sequence',
  );

  // 新修订落地后，迟到的旧上传返回已被取代的旧修订，旧值不会复活
  const rev2 = app.results.ingestRevision(resultInput(chain, { value: 0.12, contentHash: 'hash-rev2', revisionNumber: 2 }));
  const late = app.results.ingestRevision(resultInput(chain, { value: 0.5, contentHash: 'hash-rev1', revisionNumber: 1 }));
  assert.equal(late.id, rev1.id);
  assert.equal(late.status, 'SUPERSEDED');
  assert.equal(currentResult(app).value, 0.12);
  assert.equal(currentResult(app).revisionNumber, 2);
  assert.equal(app.store.results.get(rev2.id)?.status, 'CURRENT');
  assert.equal([...app.store.results.values()].length, 2);
});

test('批准后退回：已批准批次拒绝新复核，重复批准复用既有结论', () => {
  const chain = createChain();
  const { app, batchId } = chain;
  const rev1 = app.results.ingestRevision(resultInput(chain, { revisionNumber: 1 }));
  const approval = app.quality.decide(decideInput(chain, rev1.id, { clientOperationId: 'approve-op-1' }));
  const approved = app.quality.approveBatch(batchId, 'reviewer_01');
  assert.equal(approved.status, 'APPROVED');

  // 重复批准：复用既有结论，不产生新的审计与出站消息
  const auditBefore = app.store.audit.length;
  const outboxBefore = app.store.outbox.length;
  const again = app.quality.approveBatch(batchId, 'reviewer_01');
  assert.equal(again.status, 'APPROVED');
  assert.equal(again.approvedAt, approved.approvedAt);
  assert.equal(again.version, approved.version);
  assert.equal(app.store.audit.length, auditBefore);
  assert.equal(app.store.outbox.length, outboxBefore);

  // 重复点击批准（同一结果同一结论）：仍然只有一份结论
  const repeated = app.quality.decide(decideInput(chain, rev1.id, {}));
  assert.equal(repeated.id, approval.id);
  assert.equal([...app.store.quality.values()].length, 1);

  // 批准后退回：新的退回回执被拒绝，批次保持已批准
  expectDomainError(
    () => app.quality.decide(decideInput(chain, rev1.id, { decision: 'RETEST_REQUIRED', reason: 'late retest request', reviewerId: 'reviewer_02', clientOperationId: 'review-op-late' })),
    'quality.batch_already_approved',
  );
  assert.equal(app.store.batches.get(batchId)?.status, 'APPROVED');
  assert.equal([...app.store.quality.values()].length, 1);

  // 已批准批次也不再接受新的运行与修订
  expectDomainError(
    () => app.results.registerRun({ tenantId, projectId, batchId, externalRunId: 'RUN-002', rawFileHash: 'raw-002', instrumentSoftwareVersion: 'instr-7.2', startedAt: '2026-10-06T13:00:00.000Z' }),
    'result.batch_not_accepting',
  );
  expectDomainError(
    () => app.results.ingestRevision(resultInput(chain, { value: 0.99, contentHash: 'hash-rev2', revisionNumber: 2 })),
    'result.batch_not_accepting',
  );
});

test('最终拒收与退回重测不同：最终拒收的批次保持关闭', () => {
  const chain = createChain();
  const { app, batchId } = chain;
  const rev1 = app.results.ingestRevision(resultInput(chain, { revisionNumber: 1 }));
  app.quality.decide(decideInput(chain, rev1.id, { decision: 'REJECTED', reason: 'contaminated beyond retest', clientOperationId: 'review-op-final' }));
  assert.equal(app.store.batches.get(batchId)?.status, 'REJECTED');
  assert.equal(app.store.batches.get(batchId)?.rejectionKind, 'REJECTED');

  expectDomainError(
    () => app.results.registerRun({ tenantId, projectId, batchId, externalRunId: 'RUN-002', rawFileHash: 'raw-002', instrumentSoftwareVersion: 'instr-7.2', startedAt: '2026-10-06T13:00:00.000Z' }),
    'result.batch_not_accepting',
  );
  expectDomainError(
    () => app.results.ingestRevision(resultInput(chain, { value: 0.12, contentHash: 'hash-rev2', revisionNumber: 2 })),
    'result.batch_not_accepting',
  );
  assert.equal(app.store.batches.get(batchId)?.status, 'REJECTED');
});

test('证据包生成前后的状态变化：快照一致，迟到回执不影响已生成证据', () => {
  const chain = createChain();
  const { app, batchId } = chain;
  const rev1 = app.results.ingestRevision(resultInput(chain, { value: 0.5, contentHash: 'hash-rev1', revisionNumber: 1 }));
  const retest = app.quality.decide(decideInput(chain, rev1.id, { decision: 'RETEST_REQUIRED', reason: 'value above limit', clientOperationId: 'review-op-1' }));

  // 退回期间生成的证据包（显式包含退回批次）如实显示 REJECTED
  const duringRejection = app.evidence.generate({ tenantId, projectId, requestKey: 'ev-during', includeRejected: true });
  assert.ok(duringRejection.sourceIds.batchIds.includes(batchId));
  assert.equal(app.store.batches.get(batchId)?.status, 'REJECTED');

  // 完成重测并批准
  const rev2 = app.results.ingestRevision(resultInput(chain, { value: 0.12, contentHash: 'hash-rev2', revisionNumber: 2 }));
  const approval = app.quality.decide(decideInput(chain, rev2.id, { decision: 'APPROVED', reason: 'retest within limits', clientOperationId: 'review-op-2' }));
  app.quality.approveBatch(batchId, 'reviewer_01');

  // 批准后生成证据包：只包含当前修订与其通过结论，旧退回结论不再出现
  const pkg = app.evidence.generate({ tenantId, projectId, requestKey: 'ev-final' });
  assert.ok(pkg.sourceIds.batchIds.includes(batchId));
  assert.deepEqual(pkg.sourceIds.resultIds, [rev2.id]);
  assert.deepEqual(pkg.sourceIds.qualityDecisionIds, [approval.id]);
  assert.ok(!pkg.sourceIds.qualityDecisionIds.includes(retest.id));

  // 证据包生成后，迟到的旧回执重试到达：复用结论，证据包保持冻结快照
  const replay = app.quality.decide(decideInput(chain, rev1.id, { decision: 'RETEST_REQUIRED', reason: 'value above limit', clientOperationId: 'review-op-1' }));
  assert.equal(replay.id, retest.id);
  const after = app.store.evidence.get(pkg.id);
  assert.equal(after?.version, pkg.version);
  assert.equal(after?.manifestHash, pkg.manifestHash);
  assert.deepEqual(after?.sourceIds, pkg.sourceIds);
  assert.equal(app.store.batches.get(batchId)?.status, 'APPROVED');

  // 相同 requestKey 重新生成返回既有证据包；冻结后依然如此
  const regenerated = app.evidence.generate({ tenantId, projectId, requestKey: 'ev-final' });
  assert.equal(regenerated.id, pkg.id);
  assert.equal(regenerated.manifestHash, pkg.manifestHash);
  const frozen = app.evidence.freeze(pkg.id);
  assert.equal(frozen.status, 'FROZEN');
  const afterFreeze = app.evidence.generate({ tenantId, projectId, requestKey: 'ev-final' });
  assert.equal(afterFreeze.status, 'FROZEN');
  assert.equal(afterFreeze.id, pkg.id);
});

test('每份结论都绑定明确的批次版本与结果修订', () => {
  const chain = createChain();
  const { app, batchId } = chain;
  const rev1 = app.results.ingestRevision(resultInput(chain, { revisionNumber: 1 }));

  const versionBeforeApproval = app.store.batches.get(batchId)?.version;
  const approval = app.quality.decide(decideInput(chain, rev1.id, { clientOperationId: 'approve-op-1' }));
  assert.equal(approval.batchVersion, versionBeforeApproval);
  assert.equal(approval.resultRevisionNumber, 1);
  assert.equal(approval.clientOperationId, 'approve-op-1');

  // 退回结论记录的是退回发生时的批次版本与被退回的修订号
  const chain2 = createChain();
  const r1 = chain2.app.results.ingestRevision(resultInput(chain2, { value: 0.5, contentHash: 'hash-rev1', revisionNumber: 1 }));
  const versionBeforeRetest = chain2.app.store.batches.get(chain2.batchId)?.version;
  const retest = chain2.app.quality.decide(decideInput(chain2, r1.id, { decision: 'RETEST_REQUIRED', reason: 'value above limit', clientOperationId: 'review-op-1' }));
  assert.equal(retest.batchVersion, versionBeforeRetest);
  assert.equal(retest.resultRevisionNumber, 1);
});
