# HTTP API

Base URL 示例：`https://flight.example.com`。机器可读定义见 [openapi.json](openapi.json)，运行时可读取 `/openapi.json`。

## 鉴权与用户隔离

除 `GET /healthz` 外，所有请求必须带：

```http
Authorization: Bearer <服务 API Key>
X-User-Id: <可信服务端识别的登录用户 ID>
```

服务 Key 来自 `secrets/service-api-keys.json`，其 JSON key 是客户端/租户标识。该 Key **不是模型 API Key**。服务按“客户端标识 + 用户 ID”隔离批次、任务、事件和证据；其他用户访问统一返回 404。

`X-User-Id` 允许字母、数字、`_ . @ -`，最长 128 字符。必须由妙搭服务端从已验证的登录上下文产生，不能直接信任前端填写的用户 ID。服务不提供跨域前端直连模式。

## 提交批次

`POST /v1/batches`

另带 `Idempotency-Key`：8–128 个字母、数字、`_` 或 `-`。建议每次新的提交动作使用 UUID；同一次请求因断网重试时继续使用同一个键。

```json
{"mawbs":["176-65598013","045-54026221","invalid"]}
```

也接受文本：

```json
{"mawbs":"176-65598013\n045-54026221"}
```

- 1–100 项；文本可用换行、空格、逗号或分号分隔。
- 自动规范化全角数字和连接符、保留前导零，重复号码只创建一次任务。
- 错误格式不让整批失败：该项生成 `invalid_input`；过长、空批次、超过上限等请求结构错误返回 400。
- 不验证模 7 校验位，避免拒绝航司实际接受的号码。
- 只接受 `mawbs`，不接受 prompt、URL、模型配置或其他额外字段。

首次返回 `202 Accepted`，带 `Location: /v1/batches/{id}`；同用户同幂等键且规范化列表相同返回 200、`reused: true`；不同列表返回 409。

响应结构（ID 为示意）：

```json
{
  "id":"00000000-0000-4000-8000-000000000001",
  "createdAt":"2026-09-29T00:00:00.000Z",
  "duplicates":0,
  "total":1,
  "finished":0,
  "status":"queued",
  "reused":false,
  "jobs":[{
    "id":"00000000-0000-4000-8000-000000000002",
    "batchId":"00000000-0000-4000-8000-000000000001",
    "mawb":"176-65598013",
    "status":"queued",
    "attempt":0,
    "maxAttempts":2,
    "cancelRequested":false,
    "stage":"排队中",
    "result":null,
    "errorCode":null,
    "createdAt":"2026-09-29T00:00:00.000Z",
    "updatedAt":"2026-09-29T00:00:00.000Z"
  }]
}
```

## 查询批次与任务

- `GET /v1/batches/{id}`：上述批次结构，不含 `reused`。
- `GET /v1/batches?limit=10&offset=0`：`{items, limit, offset}`，limit 最大 20，只列当前用户历史。
- `GET /v1/jobs/{id}`：单个 job 对象。

建议每 3 秒轮询当前批次，直到 `status=finished`。刷新页面用保存的 batchId 恢复；不需要保持提交请求长连接。

批次 `finished` 只代表所有任务已结束，**不代表全部查询成功**。逐票状态为：

| 状态 | 含义 |
|---|---|
| queued | 排队或等待自动重试 |
| running | Codex 正在查询 |
| succeeded | 空运段实际时间和全程完成信息齐全 |
| partial | 有部分信息、拆批或时间冲突；可能已有首页所需的两项时间 |
| not_found | 官网有对应提单明确无记录的证据 |
| blocked | 验证码自动处理未通过、登录、访问限制、无有效证据或结果校验受阻 |
| failed | 超时、进程或协议失败，已用完本轮重试预算 |
| cancelled | 用户取消 |
| invalid_input | 提单格式不正确，未执行查询 |

`stage` 是供界面显示的中文阶段，不应据此驱动业务逻辑；使用 status/errorCode。

## 查询结果

完成后 `job.result` 包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| mawb | string | 规范化主提单号 |
| status | enum | complete / partial / not_found / blocked |
| carrier | string/null | 承运航空公司 |
| origin / destination | string/null | 运单始发和最终目的地机场代码 |
| pieces / weight | integer/null、string/null | 总件数、带单位重量 |
| journeyComplete | boolean | 是否有全票完成证据 |
| completionEvidenceId / completionQuote | string/null | 行程完成证据；不是 ATA 来源替代物 |
| summary.atd / summary.ata | SummaryTime | 首页两项汇总 |
| segments | Segment[] | 空运及公路分段 |
| issues | Issue[] | 缺失、冲突、受阻说明 |
| evidenceIds | string[] | 模型结果所引用、且服务验证存在的证据编号 |
| sourceUrls | string[] | 本次实际采集的来源，保留 SPA hash |
| checkedAt | string | 服务端查询完成时间，ISO 8601 |

`SummaryTime`：

```json
{"value":null,"kind":"multiple","note":"分批到达"}
```

kind 为 `value / missing / multiple / conflict`。value 仅在唯一可核实的时间存在时非空。`note=仅部分记录` 表示不能把该值理解成全票完成。

`Segment`：

```json
{
  "id":"leg-1",
  "transportType":"air",
  "group":null,
  "origin":"HKG",
  "destination":"RUH",
  "flightNumber":"EK123",
  "flightDate":"01 Sep 2026",
  "pieces":237,
  "actualDeparture":{
    "value":"01 Sep 2026 10:00",
    "label":"ATD",
    "evidenceId":"00000000-0000-4000-8000-000000000003",
    "quote":"EK123 HKG RUH ATD 01 Sep 2026 10:00 ATA 01 Sep 2026 15:00"
  },
  "actualArrival":null
}
```

上面是**虚构格式示例，不是任何实际提单的查询结果**。时间字段无记录时为 null。label 只允许 ATD、DEP、Actual Departure 或 ATA、ARR、Actual Arrival，服务还按出发/到达字段分别校验。所有运输时间保留来源写法，不做时区换算。系统字段 createdAt/checkedAt 用 ISO 时间，两者用途不同。

`Issue`：

```json
{
  "code":"time_conflict",
  "message":"同航段 ATA 与 ARR 不一致，保留原始值并留空汇总。",
  "segmentId":"leg-1",
  "field":"arrival",
  "values":["01 Sep 2026 15:00","01 Sep 2026 15:04"]
}
```

field 为 departure/arrival/general；segmentId 可为 null。不要把所有 partial 都显示成“查不到”。

验证码失败使用 `captcha_unsolved`（尝试未通过/预算用尽）、`captcha_unsupported`（控件无法识别或操作）、`captcha_unavailable`（图片/资源加载失败）。不需要前端回传验证码答案；后端在有上限的自动尝试后返回结果。详见 [captcha.md](captcha.md)。

## 取消和重查

- `POST /v1/batches/{id}/cancel`：返回最新批次。排队任务立即取消，运行任务异步终止；重复取消可安全调用，已完成结果保留。
- `POST /v1/jobs/{id}/retry`：仅 partial、not_found、blocked、failed、cancelled 可重试，返回 202 和排队中的 job。queued/running/succeeded/invalid_input 返回 409。每个 job 最多执行 6 次；达到后需要明确新建批次。

重试保留原 jobId，attempt 继续增长；旧证据可按 attempt 查询。重试时旧 result 清空，避免页面将旧结果当成新查询结果。

## 事件

`GET /v1/jobs/{id}/events?after=0`

返回 `{items:[{id,attempt,kind,message,createdAt}]}`，每次最多 200 条。下一次将最后一条 id 作为 after。只包含业务阶段，不提供 Codex 原始推理或命令流。

## 证据

- `GET /v1/jobs/{id}/evidence?attempt=1`：返回 `{attempt,items}`；不填 attempt 默认最新执行次数。
- 每项含 id、kind、jobId、attempt、url、capturedAt、sha256、screenshot、sequence、textUrl、screenshotUrl。
- `GET /v1/jobs/{id}/evidence/{evidenceId}?attempt=1`：返回完整证据对象，包括 text。
- `GET /v1/jobs/{id}/evidence/{evidenceId}/screenshot?attempt=1`：有截图则返回 image/png，无截图返回 404。

`navigation_attempt` 仅是访问尝试，`page` 才是实际读取的页面。新增 `captcha` 是验证码局部截图和元数据，仅用于诊断，不能作为运输时间或无记录证据。textUrl/screenshotUrl 是相对路径，仍需带鉴权头。妙搭应由服务端代理读取，不把凭证拼到 URL。

运行期间证据正在任务隔离目录采集，结束或超时后发布到证据 API；不要将执行中暂时为空理解为“没有访问网页”。

## 错误与限流

```json
{"error":{"code":"queue_full","message":"查询队列已满，请稍后再试。"},"requestId":"req-1"}
```

- 400：字段、批次规模或身份头格式错误。
- 401：服务凭证缺失或无效。
- 404：资源不存在，或不属于当前用户。
- 409：幂等键冲突、当前状态不可重试或次数上限。
- 429：请求限流/队列已满；限流响应带 Retry-After。
- 500：服务内部错误，按 requestId 排查。

批次提交网络超时后应**使用相同 Idempotency-Key 重试**；收到有效批次编号后只轮询。POST retry 如果返回超时，先 GET job 查看是否已排队，不要立即反复重试。
