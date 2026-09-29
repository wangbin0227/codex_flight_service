# Codex Flight Service

将 Codex CLI 封装成可部署到阿里云 ECS 的空运主提单（MAWB）查询服务。用户输入一个或多个提单号，服务异步调用 Codex，通过独立 Chromium 浏览器查询 track-trace 和航司官网，返回 **ATD/ATA 汇总、分段航班和查询证据**。

本项目不包含妙搭页面源码；提供妙搭服务端接入示例。现有妙搭应用可以保留界面，替换其查询数据源。

## 能力

- 每批 1–100 票，标准化全角字符、空格和连字符，自动去重，错误输入逐票隔离。
- 持久任务队列、幂等提交、用户隔离、重试、取消、进度事件、历史批次。
- Codex CLI **0.158.0** + 自定义 MCP 浏览器工具 + Playwright **1.63.0**，无桌面端依赖。
- 每票独立 Codex 会话、浏览器上下文和临时目录；默认全局并发 2，同航司并发 1。
- 先尝试 track-trace，再查询官方入口；176 前缀带 e-SkyCargo 操作指引，不硬编码任何提单结果或 shipment ID。
- 返回原始时间，不转换时区；不把 ETA、收货、入库、签收时间当作 ATD/ATA。
- 浏览器原文和可选截图形成带摘要与签名的证据，服务校验同票、同航段、原文、实际标签；冲突值不进入唯一时间汇总。
- 任务与证据存在服务器，关闭网页不会中断查询。

**验证码：**后端已提供模型看图、图形码填写、限定区域点选/拖动和有上限的重试，详见 [验证码能力与验收](docs/captcha.md)。输入仍只有提单号，无需用户填写验证码或新建 OCR 服务。

**能力边界：**登录、未通过的验证码、访问限制、页面改版、网络和模型能力会影响单票成功率。服务自动结束受阻任务并返回原因，不伪造时间，不承诺所有航司都可无人值守。规则校验不等于语义正确性的数学证明，真实航司样例必须持续回归。

## 文档

- [阿里云部署与升级](docs/deployment.md)
- [不使用 Docker：原生 systemd 部署](docs/deployment-native.md)，默认串行查询，附低内存试运行配置。
- [接口文档](docs/api.md) / [OpenAPI 3.1](docs/openapi.json)
- [妙搭接入说明](docs/miaoda.md) / [服务端客户端示例](examples/miaoda-server.ts)
- [架构、证据规则和运行边界](docs/architecture.md)
- [交互式详细架构图（离线 HTML）](docs/architecture.html)：下载后用浏览器打开，包含系统总览、时序、状态机、证据校验、数据关系和部署拓扑。
- [验证记录和验收步骤](docs/validation.md)
- [Codex 输出 JSON Schema](docs/shipment.schema.json)

## 本地开发

需要 Node.js **24+**（推荐 24 LTS）。

```bash
npm ci
npm run check
node --import tsx scripts/init-secrets.ts
npm run browser:install
```

编辑 `secrets/model-api-key.txt` 填入模型 Key。`secrets/service-api-keys.json` 已生成服务凭证。**两种 Key 用途不同，不要放入前端、Git、截图或日志。**

建立 `.env`，设置下面这些值（其余参考 `.env.example`）：

```dotenv
SERVICE_API_KEYS_FILE=./secrets/service-api-keys.json
CODEX_API_KEY_FILE=./secrets/model-api-key.txt
CODEX_MODEL=gpt-6-sol
CODEX_REASONING_EFFORT=high
# 自定义 Responses 网关按实际填写；留空使用默认 OpenAI provider。
CODEX_BASE_URL=
DATA_DIR=./runtime
```

分别启动两个终端：

```bash
node --env-file=.env dist/src/main.js
```

```bash
node --env-file=.env dist/src/worker-main.js
```

验证浏览器和执行真实查询（后者会消耗模型额度）：

```bash
node --env-file=.env dist/scripts/doctor.js --network
node --env-file=.env dist/scripts/smoke.js 176-65598013
```

`doctor` 验证二进制、浏览器启动和可选目录连通；它不验证模型认证、航司查询成功或所有工具兼容。`smoke` 才经过 API → 队列 → Codex → 浏览器 → 校验 → 结果全链路。

默认每次执行 600 秒；工具 90 秒、浏览器导航 45 秒、动态结果等待 30 秒、整体快照 20 秒。主要超时可通过环境变量修改，预算关系见[部署文档](docs/deployment.md#超时预算)。`smoke` 分别给排队和执行各 30 分钟，支持通过 `FLIGHT_BATCH_ID` 恢复轮询。

## 生产部署

可以选择 [Docker Compose](docs/deployment.md)，或 [直接安装到服务器、由 systemd 管理](docs/deployment-native.md)。原生方案提供专用账号、凭证注入、持久数据目录和默认并发 1 的配置；不需要 Docker。去掉 Docker 仍不能保证 1GB 服务器稳定运行，Chromium 与查询进程的峰值内存需要实测。

项目将任务与队列一起存入 SQLite WAL，适用于**一台 ECS、本地持久磁盘**，不需要额外 Redis/PostgreSQL。多 Worker 在同台机器共用数据库时也通过事务和租约限流；不要把 SQLite 文件放在 OSSFS/NFS，也不要直接跨 ECS 共享数据库。扩展到多机时应替换 Store 为 PostgreSQL/独立队列。

仓库内的 CLI、浏览器和依赖已锁定。Docker 镜像使用自己的 CLI，不会读取或覆盖宿主机已有的 Codex 配置；原生部署可用 `CODEX_BIN` 指定已安装的 CLI，但须重新执行兼容性和真实查询验收。

## 目录

```text
src/api.ts              HTTP 接口、鉴权、用户隔离
src/store.ts            SQLite 持久队列、租约、幂等、取消
src/worker.ts           并发调度、心跳、重试与校验
src/runtime/            Codex 子进程、固定提示词与隔离配置
src/browser/            MCP 工具、Chromium、公网出口限制
src/evidence.ts         证据签名、原文验证、时间汇总
scripts/                检查、真实查询验收、密钥初始化、备份
examples/               妙搭服务端接入示例
config/                 HTTPS 反向代理配置
```

## 官方参考

- [Codex 无交互执行](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)

本服务自行提供业务 HTTP API，并不将 Codex App Server 直接暴露给公网。
