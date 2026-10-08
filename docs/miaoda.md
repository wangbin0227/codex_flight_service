# 接入现有妙搭应用

现有应用的页面仍由妙搭托管；Codex 和浏览器在阿里云执行。本仓库没有修改现有妙搭线上应用。

## 配置

妙搭服务端保存两个环境变量：

- `FLIGHT_SERVICE_URL`：如 `https://flight.your-domain.com`。
- `FLIGHT_SERVICE_KEY`：服务器 `secrets/service-api-keys.json` 中专门分配给妙搭的 Key。

模型 Key 只放阿里云 Worker；这个新数据源不需要妙搭持有模型 Key。切换成功前不要删除旧配置，便于回滚。

## 服务端代理

1. 妙搭先检查用户登录，通过平台 `userContext` 等实际登录上下文取得用户 ID。
2. 前端传入提单列表和一次提交动作的 idempotencyKey；用户 ID 不由前端决定。
3. 后端通过工程规定的 Nest HttpService 请求查询服务，带 Authorization、X-User-Id 和 Idempotency-Key。
4. 查询/取消/重试/证据接口同样从当前登录身份构造 X-User-Id；不透传用户任意指定的服务 URL。
5. 客户端示例见 `examples/miaoda-server.ts`。示例用标准 fetch 表达协议，妙搭项目应按自身 HttpService 规范移植。

## 页面状态

- 提交成功后立即保存 batchId，进入进度页面。每 3 秒从妙搭后端读取批次，完成后停止轮询。
- 刷新页面先读历史批次或已保存 batchId，不再次提交同一批查询。
- `queued` 显示“排队中”，`running` 显示当前 stage。排队不计入每次执行的 600 秒；批次多票时总时间会更长。
- 单次 HTTP 超时或前端等待到期时显示“暂未取得最新进度，后台任务继续”，保留 batchId 并允许恢复轮询；不能直接把任务改成失败或重复提交。只有用户明确点击取消才调用取消接口。
- 第一部分：提单号、`result.summary.atd`、`result.summary.ata`。当 kind=value 时显示 value，并同时显示非空 note（如“待核实：航段归属或件数未确认”）；当 kind=multiple/conflict/missing 时显示 note，不填造时间。
- 分批运输正常返回首批 ATD 和末批 ATA；ATA 的 note 若含“仅部分记录”，表示已知最晚到达而非整票到齐。全部到齐时显示末批时间与件数说明，所有批次仍保留在明细。multiple 仅用于无法比较先后的时间，不能把所有拆批都改为空值。
- 第二部分：`result.segments` 的航班、路线、拆批、时间对象和 `result.issues`。
- 对 partial 保留已有时间；显示待核实、缺失或冲突细节，不统一显示“查询失败”。`issues.code=time_context_unverified` 可按 segmentId、field 给对应时间加“待核实”标记；字段结构和现有接口保持兼容。
- 重查按钮仅对可重试终态显示；发送后重新轮询，展示 attempt。
- 证据链接经妙搭服务端代理，不能用 `?token=...` 暴露服务 Key；原文显示为文本，不作为 HTML 插入。

## 与原实现的字段差异

原页面若使用 `segment.actualDeparture: string|null`，新服务为 `{value,label,evidenceId,quote}|null`。适配时取 `.value` 渲染、保留 evidenceId 做证据跳转。首页直接用服务给出的 summary，不在前端另写一套汇总规则。

原接口一次 POST 返回整票结果，新接口先返回 batchId。不要在妙搭同一次请求内等待 Worker 完成；短轮询可以避免平台请求时限导致 504。

部署验收通过后，再将妙搭的数据源切换到该服务。服务 URL、凭证和阿里云网络未验证前，不把页面标注为已接入真实查询。
