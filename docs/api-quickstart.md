**空运提单查询 API · 接入说明**

按空运主提单号查询运输记录，返回航段、实际起飞时间（ATD）、实际到达时间（ATA）及来源证据。接口采用异步查询：**提交提单 → 获取批次 ID → 轮询结果**。

服务地址：`https://8.209.238.96/flight`

API Key 由服务方单独提供，请保存在接入方后端，勿放入前端代码。以下示例从服务端环境变量 `FLIGHT_SERVICE_KEY` 读取 Key。

所有业务请求携带以下请求头：

| 请求头 | 填写方式 |
|---|---|
| `Authorization` | `Bearer <API_KEY>` |
| `X-User-Id` | 当前业务用户的唯一标识，如 `user-001`，由可信后端确定 |
| `Content-Type` | 提交 JSON 时使用 `application/json` |
| `Idempotency-Key` | 仅提交查询时必填，建议使用 UUID |

同一用户后续查询、证据读取等操作，须使用相同的 API Key 和 `X-User-Id`。用户标识支持 1–128 位英文字母、数字及 `_.@-`。

**提交查询**：`POST /v1/batches`

将示例提单号替换为真实提单号；每次新提交生成新的 `Idempotency-Key`，同一次提交因网络失败重发时沿用原值。

```bash
curl -sS 'https://8.209.238.96/flight/v1/batches' \
  -H "Authorization: Bearer ${FLIGHT_SERVICE_KEY}" \
  -H 'X-User-Id: user-001' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 8c5b5be4-2330-4fa2-8d15-602a0c8ed562' \
  -d '{"mawbs":["176-12345678"]}'
```

`mawbs` 为提单号数组，格式为三位前缀加八位号码。重复号码自动去重，错误号码标记为 `invalid_input`，不影响同批其他有效号码。

首次受理返回 **HTTP 202**；相同幂等请求返回 **HTTP 200** 并复用原批次。保存返回的顶层 `id`，作为后续使用的 `batchId`。此时尚未得到最终运输结果。

**获取结果**：`GET /v1/batches/{batchId}`

每 **3 秒**查询一次，将下例 `<batchId>` 替换为提交返回的 `id`：

```bash
curl -sS 'https://8.209.238.96/flight/v1/batches/<batchId>' \
  -H "Authorization: Bearer ${FLIGHT_SERVICE_KEY}" \
  -H 'X-User-Id: user-001'
```

批次顶层 `status` 为 `queued`、`running` 或 `finished`。到达 **`finished`** 时停止轮询，再检查 `jobs` 中每票的状态和结果。

| 单票字段（`jobs[]` 内） | 用途 |
|---|---|
| `id`、`mawb` | 任务 ID、提单号 |
| `status`、`stage` | 单票状态、当前进度说明 |
| `result.summary.atd` | 首发实际起飞时间，包含 `value`、`kind`、`note` |
| `result.summary.ata` | 末程实际到达时间，包含 `value`、`kind`、`note` |
| `result.segments` | 航班、路线及各航段实际时间 |
| `result.issues` | 缺失、冲突或校验问题说明 |
| `errorCode` | 执行错误代码；无执行错误时为 `null` |

结果尚未生成或任务执行失败时，`result` 可为 `null`。时间对象的 `kind=value` 时显示 `value` 和非空 `note`（包括“候选时间：存在冲突，待核实”或“仅部分记录”）；`missing`、`multiple`、`conflict` 时显示 `note`，可结合 `issues` 查看原因。有原文依据的冲突候选沿用 `kind=value`，选择依据和其他冲突时间在 `issues.code=time_conflict` 中保留，相关首末结果保持 partial；不能因存在该 issue 再隐藏候选，也不能省略 note。`time_context_unverified` 表示时间原文已取得、航段或件数仍待核实，不能仅凭 value 非空认定完全核实。

| 单票状态 | 含义 |
|---|---|
| `queued` / `running` | 排队中 / 执行中 |
| `succeeded` | 首发 ATD、末程 ATA 及全票完成已核实 |
| `partial` | 查询完成，部分数据待核实、缺失或存在冲突，仍展示已有时间及说明 |
| `not_found` / `blocked` | 官网无记录 / 查询受阻 |
| `failed` / `cancelled` / `invalid_input` | 执行失败 / 已取消 / 提单号格式错误 |

**对接约定**

- 当前每用户排队与执行中的任务合计最多 **20 票**，每用户最多 **120 次请求/分钟**。
- 每票单次执行上限 **600 秒**，遇到可重试的执行错误时自动重试，最多 **2 次尝试**。排队时间另计，批次总耗时可能超过 10 分钟。
- HTTP 请求建议设置 15–30 秒超时。网络中断或页面等待超时后，保存 `batchId` 并恢复轮询，后台任务仍会继续，勿重复新建批次。
- 实际时间保留官网原始表达，不统一转换时区。官网缺失、数据冲突或证据校验未通过时，时间可能为空；`partial` 不保证 ATD/ATA 均有值。
- 中间航段时间缺失可在 `issues` 中说明，不单独导致 `partial`；查看分段和问题说明以了解记录完整性。

常见 HTTP 错误：`400` 参数错误；`401` 凭证无效；`404` 记录不存在或不属于当前用户；`409` 幂等键与提单列表冲突；`429` 限流或队列已满，稍后重试（响应有 `Retry-After` 时按其秒数等待）。具体原因见响应中的 `error.code` 和 `error.message`。

按需使用：

| 功能 | 接口 |
|---|---|
| 取消批次中未完成的任务 | `POST /v1/batches/{batchId}/cancel` |
| 获取单票结果 | `GET /v1/jobs/{jobId}` |
| 获取原文及截图证据列表 | `GET /v1/jobs/{jobId}/evidence` |
| 完整接口定义 | `GET /openapi.json` |

以上路径均追加到服务地址后，并携带相同鉴权头。证据列表返回的 `textUrl`、`screenshotUrl` 也追加到服务地址后访问；`screenshotUrl=null` 表示没有截图。导入 OpenAPI 时，将其中的示例服务地址替换为上方实际地址。
