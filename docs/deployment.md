# 阿里云 ECS 部署

本页为 Docker Compose 路径。**不使用 Docker 时，请按 [原生 systemd 部署](deployment-native.md) 操作**；两者使用同一套 API 和 Worker 代码，原生配置默认并发 1。

## 1. 环境与部署范围

推荐首版使用 Ubuntu 24.04 / Debian 12、x86_64 ECS，**4 vCPU / 8 GB RAM / 40 GB 以上磁盘**，并发从 2 开始。这是容量起点，不是压测保证。需要 Docker Engine 和 Compose v2，可从 Docker 官方源安装。

- 国内地域必须实测模型网关、GitHub/npm/浏览器下载源及航司网站的出站 HTTPS；安装成功不能证明航司可访问。
- 使用海外地域也仍需实测站点风控和网络。
- 首次构建会下载 Linux Codex、Chromium 和系统依赖，耗时明显高于普通 Node 应用。
- 阿里云安全组：SSH 仅对管理来源开放；HTTPS 部署开放 80/443。8080 只绑定本机，不对公网开放。
- 域名 A 记录指向 ECS；中国内地的域名/网站备案要求按实际部署办理。
- 服务采用 API Key 认证。妙搭服务端通过 HTTPS 调用；浏览器前端不能持有服务 Key。

## 2. 获取代码

```bash
git clone https://github.com/wangbin0227/codex_flight_service.git
cd codex_flight_service
cp .env.example .env
```

按本次交付的分支或 commit 检出固定版本后部署，不在生产机直接运行未审查的新提交。

```bash
git checkout codex/flight-query-service
```

## 3. 创建密钥文件

如果服务器有 Node 24+：

```bash
npm ci
node --import tsx scripts/init-secrets.ts
```

如果只安装 Docker，可用如下初始化命令（只生成服务密钥，不把密钥打印到终端）：

```bash
mkdir -p secrets
chmod 700 secrets
docker run --rm -v "$PWD/secrets:/secrets" node:24-bookworm-slim node -e '
const fs=require("node:fs"),crypto=require("node:crypto");
for(const [name,value] of [["service-api-keys.json",JSON.stringify({miaoda:crypto.randomBytes(32).toString("hex")})],["model-api-key.txt",""]]) {
  try { fs.writeFileSync("/secrets/"+name,value,{flag:"wx",mode:0o600}); }
  catch(e) { if(e.code!=="EEXIST") throw e; }
}'
```

使用服务器上的安全编辑器将模型 API Key 写入 `secrets/model-api-key.txt`。可复用已获授权的现有网关凭证，不能把整个个人 Codex 配置目录挂入容器。

Compose 的文件型 secrets 通常保留宿主文件属主。本镜像进程 UID/GID 为 `1000:1000`，文件必须允许该 UID 读取：

```bash
sudo chown 1000:1000 secrets/service-api-keys.json secrets/model-api-key.txt
sudo chmod 600 secrets/service-api-keys.json secrets/model-api-key.txt
```

`secrets/` 已被 Git 和 Docker build context 排除。Key 不进入镜像；API 容器仅挂服务 Key，Worker 容器仅挂模型 Key。

## 4. 配置 `.env`

```dotenv
SERVICE_DOMAIN=flight.your-domain.com
CODEX_MODEL=gpt-6-sol
CODEX_REASONING_EFFORT=high
CODEX_BASE_URL=https://your-authorized-gateway.example/v1
WORKER_CONCURRENCY=2
JOB_TIMEOUT_SECONDS=600
MCP_STARTUP_TIMEOUT_SECONDS=60
MCP_TOOL_TIMEOUT_SECONDS=90
BROWSER_LAUNCH_TIMEOUT_SECONDS=45
BROWSER_NAVIGATION_TIMEOUT_SECONDS=45
BROWSER_WAIT_TIMEOUT_SECONDS=30
BROWSER_SNAPSHOT_TIMEOUT_SECONDS=20
BROWSER_PROXY_IDLE_TIMEOUT_SECONDS=60
MAX_ATTEMPTS=2
MAX_QUEUED=1000
MAX_OWNER_QUEUED=200
REQUESTS_PER_MINUTE=120
```

- `CODEX_BASE_URL` 留空：使用默认 OpenAI provider。自定义地址必须为 HTTPS，证书校验保持开启；证书错误应修复证书，不能关闭 TLS 校验。
- 自定义网关需要支持 Codex 使用的 Responses API、工具调用、流式结果和结构化输出。不能只用一次普通对话成功来判断兼容。
- 模型必须在你的网关/账户中实际可用。这里沿用本项目需求指定的名称，不保证任何账户都有此模型。
- 验证码流程需要模型和网关支持 MCP 图像输入。航司入口、iframe 和图片等资源允许访问任意公网 HTTPS 域名，无需配置域名白名单；用法、重试预算和验收见 [captcha.md](captcha.md)。
- `CODEX_REASONING_EFFORT` 默认 `high`，写入每票 Codex 会话的 `model_reasoning_effort`。其他强度需要当前模型与 CLI 支持。修改模型或推理强度后执行 `docker compose up -d --no-build worker` 重新创建 Worker；仅 `restart` 不会更新容器环境变量。
- 全局并发在数据库层限制，同航司前缀最多一个运行任务；API 和 Worker 的超时相互独立。

### 超时预算

上述超时单位都是秒，可在 `.env` 修改，再执行 `docker compose up -d --no-build worker` 生效。原生部署需要启动命令显式加载 `.env`。

| 配置 | 默认 | 范围及含义 |
|---|---:|---|
| `JOB_TIMEOUT_SECONDS` | 600 | 30–900；每次 Codex 执行上限，不包括排队和执行后的证据归档 |
| `MCP_STARTUP_TIMEOUT_SECONDS` | 60 | 1–180；浏览器 MCP 初始化，至少比 Chromium 启动预算多 10 秒 |
| `MCP_TOOL_TIMEOUT_SECONDS` | 90 | 1–300；一次工具调用，包括操作、可选结果等待和快照 |
| `BROWSER_LAUNCH_TIMEOUT_SECONDS` | 45 | 1–120；Chromium 启动 |
| `BROWSER_NAVIGATION_TIMEOUT_SECONDS` | 45 | 1–120；导航至 DOM 加载完成 |
| `BROWSER_WAIT_TIMEOUT_SECONDS` | 30 | 1–120；指定结果/错误文字出现，或观察到的加载提示消失 |
| `BROWSER_SNAPSHOT_TIMEOUT_SECONDS` | 20 | 1–60；整个快照，包括所有框架、可选截图与证据保存 |
| `BROWSER_PROXY_IDLE_TIMEOUT_SECONDS` | 60 | 1–180；浏览器出站连接无数据活动的期限，不是整个请求耗时 |

配置加载时检查：工具预算至少覆盖 `max(导航, 20 + 结果等待) + 快照 + 10` 秒；出站空闲期限不小于导航和结果等待预算。过小的组合会拒绝启动，避免内部步骤尚未结束就被外层截断。

快照每个框架批量读取最多 360 个控件（含验证码区域），避免逐个跨进程访问。快照超时、MCP 请求取消，或工具执行达到外层预算前 5 秒时，会关闭浏览器和代理并作废引用，阻止残留操作和并行调用污染结果。该会话关闭后不能继续操作；需要新的任务尝试。

点击/Enter 可带 `waitFor: { text, state: "visible" | "hidden" }`。提交后必须等待并核实结果/错误；DOM 加载完成、加载提示消失和空白快照都不等于查询成功或无记录。`browser_wait` 也支持这两种状态。

HTTP 接口、Nginx、任务租约和停机宽限的超时保持独立，不随浏览器预算一起增加。

## 5. 构建并启动

```bash
docker compose build
docker compose up -d api worker
docker compose ps
curl --fail http://127.0.0.1:8080/healthz
```

`/healthz` 只表示 API 进程存活。Worker 需要同时正常运行；业务就绪检查是带身份的 `/readyz`。

浏览器检查，不使用模型额度：

```bash
docker compose exec worker node dist/scripts/doctor.js --network
```

此步骤应显示 Codex 版本、`browser: started`、track-trace 来源和 `evidenceCaptured: true`。不能用它代替真实查询。

## 6. 真实查询验收

通过 API 容器执行示例客户端，它可以读取该容器的服务凭证：

```bash
docker compose exec api node dist/scripts/smoke.js 176-65598013
```

该脚本创建真实任务，持续读取进度，输出最终汇总与详情；会消耗模型额度。失败时退出码非零。`partial` 只有 ATD 和 ATA 均存在时才通过此脚本的基本验收，**仍需检查航段与冲突说明**。

脚本按观测到的批次状态分别累计排队和执行等待时间，默认各 30 分钟。可通过脚本环境变量 `FLIGHT_QUEUE_TIMEOUT_SECONDS` / `FLIGHT_POLL_TIMEOUT_SECONDS` 调整；重试等待计入排队预算。网络短暂中断会继续轮询同一批次。客户端到期仅停止等待，不取消后台任务。

恢复已提交批次（保持相同服务凭证和用户身份，不会再次提单）：

```bash
docker compose exec -e FLIGHT_BATCH_ID=已有批次UUID api node dist/scripts/smoke.js
```

服务端排队没有自动过期期限，600 秒从每次执行开始计算。批量任务应按票数和并发设置客户端预算，并保留 batchId 供恢复查询。

浏览器本地回归（不调用模型或外部航司）：

```bash
docker compose exec worker node dist/tests/browser.integration.js
```

验收要求：

1. 从提单号开始查询，非预先填写 shipment ID 或回放历史结果。
2. 结果提单号与官网一致，首页有可核实的始发 ATD 和末程 ATA。
3. 拆批、公路转运、冲突时间完整可见；证据接口可读取对应原文。
4. 提交 2–3 票混合批次，单票失败不影响其他票。
5. 关闭客户端后任务继续；重启 Worker 后租约过期的任务在预算内恢复。
6. 不同 `X-User-Id` 无法读取对方批次和证据。

本地电脑测试不能替代阿里云出站网络和 Linux 容器验收。

## 7. 开启 HTTPS

域名已解析且 80/443 放行后：

```bash
docker compose --profile https up -d
docker compose logs --tail=50 caddy
```

Caddy 自动申请和续期证书。证书文件保存在持久卷。妙搭填写 `https://flight.your-domain.com`，不要填写容器地址、localhost 或无 TLS 的公网地址。

若使用阿里云 ALB/已有 Nginx，可不用 Caddy，但上游仅转发到本机 8080，保持鉴权头、`X-User-Id` 和 `Idempotency-Key`。接口是短轮询，不需要把代理超时延长到几分钟。

## 8. 运维

```bash
docker compose logs --tail=100 api worker
docker compose restart worker
```

日志只记录服务事件，不输出模型 Key、Codex 原始推理、浏览器完整页面或请求体。业务事件通过 `/v1/jobs/{id}/events` 查看，查询证据通过受鉴权的证据接口查看。

取消批次会立即取消排队任务，运行任务由心跳在约 2 秒内发出终止，额外最多等待 3 秒强制结束进程组。任务超时自动重试一次（默认），手动重试的总执行次数上限为 6。

进程崩溃后，运行任务的 30 秒租约过期才能恢复。后台存储提供至少一次执行语义；极端崩溃可能重复一次只读查询并产生额外模型成本，旧尝试不能覆盖新结果。

### 备份与恢复

不要仅复制正在使用的 `service.sqlite` 而忽略 WAL。建议低峰期停止 API/Worker，备份完整命名卷（任务、证据都在其中）：

```bash
docker compose stop api worker
mkdir -p backups
# 先用 docker volume ls 确认 compose 项目对应的 flight-data 卷名。
docker run --rm -v codex-flight-service_flight-data:/data:ro -v "$PWD/backups:/backup" \
  node:24-bookworm-slim tar -czf /backup/flight-data.tar.gz -C /data .
docker compose up -d api worker
```

`backups/` 可能包含运单资料，必须限制权限并存入受控备份位置，不提交 Git。需要在线数据库快照时可用 `dist/scripts/backup.js /data/backup-new.sqlite`，证据目录仍需一起备份。

默认不自动删除历史。应监控磁盘并制定留存策略；不要直接删除正在执行的 `runs/`。历史清理应在停止服务、备份后进行，后续可增加专用维护接口。

恢复：停止服务，把完整备份恢复到同名卷，确认 UID 1000 可读写，再启动；不得执行 `docker compose down -v`，否则会删除持久卷。

### 升级和回滚

1. 保存当前 commit：`git rev-parse HEAD`，备份数据和 `.env`/secrets。
2. 获取新版本并检出明确 commit，重新构建镜像。
3. `docker compose up -d --build api worker`，检查健康和真实样例。
4. 若失败，检出上一 commit 重建并启动；数据库结构不兼容时使用对应备份恢复。本版本数据库 schema 为 v1。

## 9. 常见故障

| 现象 | 排查 |
|---|---|
| API 启动失败 | secrets 文件内容/属主、磁盘权限、配置格式 |
| readyz 返回 503 | Worker 启动、模型 Key 是否为空、共享数据卷是否一致 |
| codex_start_failed | CLI 文件位置、Linux 架构、Node 版本 |
| codex_failed | 模型名称/额度/网关兼容、TLS、MCP 启动；先运行 doctor，再跑真实查询 |
| query_timeout | 航司响应慢或页面变化；先看已保存证据，再调整超时和提示词 |
| blocked | 读取 result.issues，区分验证码、登录、无结果与入口不可达 |
| Chromium 启动失败 | 系统依赖、共享内存、进程数限制；使用项目镜像可减少差异 |
| 部分页面资源被拦截 | 检查资源是否使用 HTTPS 443、DNS 是否解析到公网，以及证书和网络连接；航司与资源域名无需单独放行 |

容器中的浏览器采用 Playwright 默认启动行为，Chromium 自身的 sandbox 默认未启用；服务依靠专用非 root 容器、只读根文件系统、禁用 Codex Shell 和浏览器出口限制。高隔离需求应使用独立沙箱/微虚拟机执行池，而非与敏感业务共享 Worker 容器。
