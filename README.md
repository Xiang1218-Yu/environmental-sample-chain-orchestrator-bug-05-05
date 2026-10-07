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
- `src/services/result-service.ts`：仪器运行、外部运行号幂等和结果 revision
- `src/services/quality-service.ts`：质量结论、质控门槛和批次批准
- `src/services/evidence-service.ts`：一致性证据包、清单哈希和冻结
- `src/services/sync-service.ts`：离线 Envelope、客户端序列、payload 冲突和重放
- `src/demo/smoke.ts`：一条可运行的端到端样例
- `src/tests/quality-result-collaboration.ts`：结果修订与质量复核协作的并发/重试回归测试

## 结果修订与质量复核的协作规则

- 每条质量结论都绑定明确的批次版本（`batchVersion`）、结果修订号（`resultRevision`）和内容指纹（`resultContentHash`）。
- 复核回执可携带 `clientOperationId` 幂等键：同键同载荷的重试复用既有结论（纯回放，无副作用）；同键不同载荷判定为 `quality.decision_conflict`。
- 旧内容的重传按内容指纹识别为回放，返回原修订，不会让已取代的旧结果重新变成当前值。
- 迟到旧回执不能逆转当前结果：针对已取代修订的新回执报 `quality.result_not_current`；批次已批准/取消后报 `quality.batch_not_reviewable`。
- 回执可声明 `expectedRevision` / `expectedContentHash`，同版本不同指纹判定为 `quality.decision_conflict`。
- 批次被退回（REJECTED）后可注册重测运行，新修订到达时批次自动回到 RESULTS_PENDING 重审。
- 重复批准复用既有结论：批次已 APPROVED 时再次批准直接返回原结论，不产生重复审计与出站消息；批准后禁止再摄入新修订（`result.batch_closed`）。
- 证据包生成时校验：已批准批次的每个当前结果都必须有绑定到其修订与指纹的批准结论，否则拒绝出包（`evidence.result_unapproved`）。

## 运行

```bash
npm install
npm run build
npm run smoke
npm test
```

当前源码是**干净基线**，没有为了出题主动埋入 Bug。后续应先在这份基线上补充测试和复现证据，再从真实缺陷中生成 Bug 题目。
