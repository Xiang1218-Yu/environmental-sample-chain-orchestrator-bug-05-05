# Environmental Sample Chain Orchestrator

一个从 0-1 构建的环境样本链路编排项目基线，用来管理采样、容器封签、跨机构交接、实验室接收、分装、实验批次、仪器结果修订、质量复核和证据包导出。

## 当前实现

- `src/domain/types.ts`：领域对象、状态和同步模型
- `src/store/store.ts`：内存 Store、全局 ID、审计、Outbox 和事务快照回滚
- `src/services/sampling-service.ts`：采样记录与封存容器
- `src/services/custody-service.ts`：交出、接收、封签和温度轨迹
- `src/services/receiving-service.ts`：实验室接收、接受/隔离/拒收
- `src/services/aliquot-service.ts`：批量分装、单位换算、容量扣减和幂等操作
- `src/services/batch-service.ts`：实验批次成员、协议冻结和运行生命周期
- `src/services/result-service.ts`：仪器运行、外部运行号幂等和结果 revision（客户端修订号序列校验、同版本不同指纹冲突、退回批次重测重开）
- `src/services/quality-service.ts`：质量结论、质控门槛和批次批准（结论绑定批次版本与结果修订、回执幂等重放、重复批准复用既有结论）
- `src/services/evidence-service.ts`：一致性证据包、清单哈希和冻结
- `src/services/sync-service.ts`：离线 Envelope、客户端序列、payload 冲突和重放
- `src/demo/smoke.ts`：一条可运行的端到端样例
- `test/result-quality-collaboration.test.ts`：结果修订与质量复核协作的回归测试

## 结果修订与质量复核协作约定

- 每次质量结论都记录 `batchVersion` 与 `resultRevisionNumber`，可通过 `clientOperationId` 幂等重放；同一操作号携带不同负载会报 `quality.decision_conflict`。
- 结果上传必须携带客户端修订号：同号同指纹幂等重放（不会复活已被取代的旧修订），同号不同指纹报 `result.revision_conflict`，跳号报 `result.revision_sequence`。
- 退回（`RETEST_REQUIRED`）的批次会被重测运行或新修订重新打开为 `RESULTS_PENDING`；最终拒收（`REJECTED`）的批次保持关闭。
- 迟到旧回执只能复用既有结论，不能逆转当前结果；批次批准后拒绝新的复核（`quality.batch_already_approved`）与新的上传（`result.batch_not_accepting`）。
- 重复批准复用既有结论：`approveBatch` 对已批准批次直接返回，不产生新的审计与出站消息。

## 运行

```bash
npm install
npm run build
npm run smoke
npm test
```
