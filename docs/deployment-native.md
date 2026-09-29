# 阿里云原生部署（不使用 Docker）

适用于 Ubuntu 24.04 / Debian 12、systemd 252+，推荐 x86_64、系统级 Node.js 24 LTS。API 和 Worker 直接作为两个 systemd 服务运行；无需 Docker、PM2、Redis 或额外数据库。

本方案默认串行查询，适合低配服务器试运行。**Docker 不会为每个容器单独运行一个操作系统；去掉 Docker 只能省掉部分管理开销，Chromium、Codex 和 Node 仍然需要内存。1GB RAM / 30GB 总磁盘尚未通过目标机验证，不能保证稳定。**

## 1. 目录与进程

```text
妙搭服务端 → HTTPS 反向代理 → 127.0.0.1:8080
                              └─ codex-flight-api.service
SQLite 持久队列 ←────────────────────────┘
       ↓
codex-flight-worker.service（默认一次一票）
       └─ Codex CLI → MCP → Chromium → 航司网站
             └─ 远端模型 API
```

| 位置 | 用途 |
|---|---|
| `/opt/codex-flight-service` | 代码、编译产物、锁定版本依赖，root 管理 |
| `/opt/codex-flight-service/browsers` | 项目版本对应的 Chromium，服务只读 |
| `/etc/codex-flight-service/api.env` | API 配置，systemd 启动时读取 |
| `/etc/codex-flight-service/worker.env` | 模型、并发、超时等 Worker 配置 |
| `/etc/codex-flight-service/service-api-keys.json` | 服务 Key，root 可读，systemd 注入 API |
| `/etc/codex-flight-service/model-api-key.txt` | 模型 Key，root 可读，systemd 注入 Worker |
| `/var/lib/codex-flight-service/data` | SQLite、证据、执行中临时目录；升级不删除 |

两个进程使用专用无登录用户 `codex-flight`。不使用 root 跑浏览器，不把个人 Codex 配置目录挂载或复制进去。

## 2. 检查系统与内存

```bash
cat /etc/os-release
systemctl --version
node --version
npm --version
free -h
df -h /
swapon --show
```

需要 Node.js 24–26，推荐 24 LTS。使用 [Node.js 官方安装方式](https://nodejs.org/en/download) 安装到系统路径（如 `/usr/local/bin` 或 `/usr/bin`）；系统默认 apt 源可能只有旧版本。不要依赖 `/root/.nvm` 或交互式终端环境，服务启用了 `ProtectHome`。

1GB 内存可考虑配置 2GB Swap 作为缓冲，前提是磁盘有余量。Swap 可能大幅降低查询速度，无法替代物理内存。先检查现有 Swap；以下命令只用于**还没有 `/swapfile` 的服务器**，不要覆盖现有文件：

```bash
sudo bash <<'SH'
set -e
test ! -e /swapfile || { echo '/swapfile already exists; stop and inspect it first.'; exit 1; }
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
if ! grep -Eq '^/swapfile[[:space:]]' /etc/fstab; then
  printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
fi
SH
```

先确保至少数 GB 可用空间，之后同时监测镜像/旧构建残留、npm 缓存、Chromium、证据和系统日志。不能把 30GB 总盘当成 30GB 剩余空间。

## 3. 获取并构建代码

```bash
sudo git clone --branch codex/flight-query-service \
  https://github.com/wangbin0227/codex_flight_service.git /opt/codex-flight-service
cd /opt/codex-flight-service
sudo env NODE_OPTIONS=--max-old-space-size=256 npm ci --no-fund --no-audit
sudo env NODE_OPTIONS=--max-old-space-size=256 npm run build
```

如果内存不足导致构建失败，可在**相同 Linux 架构**的其他机器构建，再传递代码、`dist`、`package.json` 和 `package-lock.json`，在目标机执行 `npm ci --omit=dev`。这可避免目标机编译 TypeScript；依赖安装和浏览器仍需要资源。不要把 Mac 的 `node_modules` 复制到 Linux。

构建产物验证后可执行 `sudo npm prune --omit=dev --no-fund --no-audit`，运行服务不需要 TypeScript/tsx。需要再次构建时重新 `npm ci`。

## 4. 安装 Chromium 和系统依赖

```bash
cd /opt/codex-flight-service
sudo env PLAYWRIGHT_BROWSERS_PATH=/opt/codex-flight-service/browsers \
  node node_modules/playwright/cli.js install --with-deps chromium --only-shell
sudo chmod -R a+rX /opt/codex-flight-service/browsers
```

这一步会安装 Linux 库并下载与锁定 Playwright 版本一致的 headless Chromium。必须实测下载源、模型网关、track-trace 和航司官网的出站 HTTPS。机器中已有其他版本 Chrome 不等于依赖齐全。

## 5. 安装 systemd 配置

```bash
cd /opt/codex-flight-service
sudo env FLIGHT_NODE_BIN="$(command -v node)" bash scripts/install-native.sh
```

安装脚本会：检查 Linux、systemd、Node 和编译产物；创建专用用户；生成服务 Key 和空模型 Key 文件；安装两个服务单元；执行 `systemd-analyze verify` 与 `daemon-reload`。**它不会安装软件包、启动模型查询、自动启动服务或覆盖已有配置/密钥。**

编辑模型凭证与非敏感配置：

```bash
sudoedit /etc/codex-flight-service/model-api-key.txt
sudoedit /etc/codex-flight-service/worker.env
```

模型 Key 文件只写 Key 本身。`worker.env` 示例：

```dotenv
CODEX_MODEL=gpt-6-astra
CODEX_BASE_URL=https://your-authorized-gateway.example/v1
WORKER_CONCURRENCY=1
JOB_TIMEOUT_SECONDS=360
MAX_ATTEMPTS=2
BROWSER_ALLOWED_HOSTS=
```

自定义网关需兼容 Codex Responses / 工具调用 / 结构化输出。`CODEX_BASE_URL` 留空使用默认 provider；示例域名必须替换，保持 TLS 验证开启。模型名称需在账户中可用。推理强度仍在 `src/runtime/runner.ts` 中固定为 `low`，本次原生部署配置未修改这一行为。

`api.env` 默认只监听 `127.0.0.1:8080`，全局未完成队列上限 100，单用户 20。批量提交能力仍为 1–100 票，但**一次提交也受剩余队列容量与单用户上限约束**；若需一次提交 100 票，可提高 `MAX_OWNER_QUEUED`，执行仍串行。API 的 `MAX_ATTEMPTS` 决定新任务的初始预算。

模型 Key 与服务 Key 由 systemd `LoadCredential` 从 root 私有文件注入对应服务，环境中只有凭证文件路径。不要放在 Git、命令行参数、前端或公开日志中。

## 6. 启动与检查

```bash
sudo systemctl enable --now codex-flight-api codex-flight-worker
sudo systemctl status codex-flight-api codex-flight-worker --no-pager
curl --fail http://127.0.0.1:8080/healthz
sudo journalctl -u codex-flight-api -u codex-flight-worker -n 50 --no-pager
```

独立检查浏览器，无模型调用费用：

```bash
cd /opt/codex-flight-service
sudo -u codex-flight env \
  PLAYWRIGHT_BROWSERS_PATH=/opt/codex-flight-service/browsers \
  CODEX_BIN=/opt/codex-flight-service/node_modules/.bin/codex \
  node dist/scripts/doctor.js --network
```

doctor 不读取模型凭证时会显示 `modelConfigured: false`，这是正常的；此命令只验证 Node、Codex 二进制、浏览器与目录连通，不替代服务内的真实查询。若 Node 只在额外系统目录，给命令使用绝对 Node 路径并确保其目录在 PATH 中。

真实 HTTP 验收（会使用模型额度）：

```bash
cd /opt/codex-flight-service
sudo env SERVICE_API_KEYS_FILE=/etc/codex-flight-service/service-api-keys.json \
  node dist/scripts/smoke.js 176-65598013
```

脚本用 root 读取服务凭证后请求本机 API，查询本身仍由非 root Worker 执行。输出可能包含业务提单数据，避免转发完整日志。必须核对实际 ATD/ATA、拆批/公路段、冲突与证据，并观察内存峰值。1GB 机器应串行测试多次，不能只凭 healthz=ok 判断可用。

## 7. HTTPS 与妙搭接入

可复用已有 Nginx / Caddy / ALB，将 HTTPS 请求代理到本机 `127.0.0.1:8080`。若使用 Caddy，参考 [原生 Caddyfile](../deploy/native/Caddyfile.example)，其上游是本机地址，不能直接使用 Docker 版 `api:8080`。

阿里云安全组只开放需要的 80/443，SSH 限制管理来源；不要把 8080 裸露到公网。域名、TLS 和中国内地备案要求按部署环境处理。

妙搭可信服务端配置 `FLIGHT_SERVICE_URL` 和 `/etc/codex-flight-service/service-api-keys.json` 中的服务 Key，按 [接入文档](miaoda.md) 传递用户身份。前端不持有 Key。

## 8. 配置修改与内存限制

模型、网关、并发或超时改变后：

```bash
sudoedit /etc/codex-flight-service/worker.env
sudo systemctl restart codex-flight-worker
```

systemd 会在启动时重新读取 EnvironmentFile，所以这里 **restart 即可加载新的 env 配置**。与 Docker 的容器环境更新方式不同。服务单元或 drop-in 改动后另需 `sudo systemctl daemon-reload`。重启会终止当前查询；应选低峰期，并关注中断任务的剩余重试预算。

| 进程 | 原生默认限制 | 含义 |
|---|---|---|
| API | Node 堆 96MB；进程组 MemoryMax=192MB | 控制 API 资源，不是预先占用 |
| Worker | Worker Node 堆 128MB；MemoryHigh=512MB；MemoryMax=768MB | cgroup 限制包括 Codex、MCP 与 Chromium 子进程；High 超限后触发内存回收压力，Max 可能导致 OOM |
| Worker Swap | MemorySwapMax=1GB | 只是交换空间使用上限，不会自动创建 Swap |

这些值是试运行起点，没有证明能容纳每家航司页面。Node 堆上限不等于整个进程 RSS，也不会限制 Chromium；主机操作系统、HTTPS 代理和其他应用还要占用额外内存。1GB 主机仍可能 OOM，限制过紧也可能让单票查询失败。

```bash
free -h
df -h /
sudo systemd-cgtop
sudo systemctl show codex-flight-worker -p MemoryCurrent -p MemoryPeak -p MemoryMax -p MemorySwapMax
sudo journalctl -k --since '30 min ago' | grep -Ei 'oom|out of memory|killed process'
```

需要调整上限时使用 `sudo systemctl edit codex-flight-worker`，创建 `[Service]` 下的 `MemoryHigh` / `MemoryMax` / `MemorySwapMax` 覆盖。不要把盲目调高上限当作增加物理内存。

服务使用非 root、只读系统路径、独立临时目录与禁用提权；浏览器仍使用 Playwright 默认配置，未启用 Chromium 自身 sandbox。**原生服务不等同于容器隔离**，API 和 Worker 为共享数据使用同一专用系统用户，不应与敏感业务共用执行账号。

## 9. 备份、更新与回滚

先暂停外部新提交，在低峰期停止服务，备份数据和 root 私有配置：

```bash
sudo systemctl stop codex-flight-api codex-flight-worker
sudo install -d -m 0700 /var/backups/codex-flight-service
sudo bash -c 'umask 077; tar -czf "/var/backups/codex-flight-service/backup-$(date +%Y%m%d-%H%M%S).tar.gz" -C / var/lib/codex-flight-service etc/codex-flight-service'
```

备份包含密钥和业务证据，保持受限权限，不上传 Git。数据库与 WAL 应一起保存；不能只复制在线 `service.sqlite`。备份放在同一 30GB 磁盘仍会占空间，应转移到受控的异机存储并按保留策略清理。

更新时记录当前 commit，`git fetch` 后检出明确新 commit，重新 `npm ci` / `npm run build`。Playwright 版本变化时重新安装 Chromium；随后运行 `scripts/install-native.sh` 更新单元（保留已有 env/密钥），启动服务并重新验收。

```bash
sudo systemctl start codex-flight-api codex-flight-worker
```

失败则停服务，检出旧 commit 重建并启动；如果数据库结构发生不兼容变化，应恢复对应完整备份。不要删除 `/var/lib/codex-flight-service`。当前没有自动历史证据清理。

如果已经部署了 Docker 版：先停原 API/Worker 并备份其完整 `/data` 卷，复制到原生 `data` 目录并设置属主 `codex-flight:codex-flight`；把原服务 Key 和模型 Key 安全迁移到 `/etc` 对应文件，再启用新服务。不要让两种部署同时监听 8080，也不要同时操作迁移中的数据库。

## 10. 验证范围

CI 的 native job 在 Ubuntu 24.04 / Node 24 上验证安装脚本、真实 systemd API/Worker、凭证注入、重复安装不覆盖配置、受限 Worker 环境内的 Codex 二进制与 Chromium 启动。测试只提交 invalid_input，不使用真实模型 Key，也不调用航司。

CI 成功不代表 1GB 内存、阿里云出站网络或真实查询已通过。目标服务器仍须完成本页第 6、8 节的验收与监控。
