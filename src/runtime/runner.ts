import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';
import { outputSchema, type Evidence, type Job } from '../domain.js';
import { readEvidence } from '../evidence.js';
import { buildPrompt } from './prompt.js';

export interface RunResult { raw: unknown; evidence: Evidence[] }
export interface Runner { run(job: Job, signal: AbortSignal, progress: (message: string) => void): Promise<RunResult> }
export class ExecutionError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) { super(code); }
}
export class CodexRunner implements Runner {
  constructor(readonly config: Config) {}
  async run(job: Job, signal: AbortSignal, progress: (message: string) => void): Promise<RunResult> {
    if (!this.config.modelApiKey) throw new ExecutionError('model_not_configured', false);
    const base = join(this.config.dataDir, 'runs', job.id, String(job.attempt));
    const home = join(base, 'codex'), work = join(base, 'work'), evidenceDir = join(base, 'evidence');
    for (const dir of [home, work, evidenceDir]) await mkdir(dir, { recursive: true, mode: 0o700 });
    const signingKey = randomBytes(32).toString('hex');
    const mcpPath = resolve(dirname(fileURLToPath(import.meta.url)), '../browser/mcp.js');
    const settings = { jobId: job.id, attempt: job.attempt, mawb: job.mawb, evidenceDir, signingKey,
      allowedHosts: this.config.allowedHosts, resourceHosts: this.config.resourceHosts, executablePath: this.config.browserExecutable, timeouts: this.config.timeouts };
    const toml = (value: string) => JSON.stringify(value);
    const provider = this.config.modelBaseUrl ? `model_provider = "flight_gateway"
[model_providers.flight_gateway]
name = "Configured flight service provider"
base_url = ${toml(this.config.modelBaseUrl)}
wire_api = "responses"
env_key = "CODEX_API_KEY"
requires_openai_auth = false
` : '';
    await writeFile(join(home, 'config.toml'), `model = ${toml(this.config.model)}
model_reasoning_effort = ${toml(this.config.reasoningEffort)}
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
${provider}
[features]
shell_tool = false
unified_exec = false
apps = false
plugins = false
hooks = false
multi_agent = false
memories = false
browser_use = false
computer_use = false
[mcp_servers.flight_browser]
command = ${toml(process.execPath)}
args = [${toml(mcpPath)}]
required = true
startup_timeout_sec = ${this.config.timeouts.mcpStartupMs / 1000}
tool_timeout_sec = ${this.config.timeouts.mcpToolMs / 1000}
default_tools_approval_mode = "prompt"
[mcp_servers.flight_browser.tools.browser_open]
approval_mode = "approve"
[mcp_servers.flight_browser.tools.browser_snapshot]
approval_mode = "approve"
[mcp_servers.flight_browser.tools.browser_click]
approval_mode = "approve"
[mcp_servers.flight_browser.tools.browser_fill]
approval_mode = "approve"
[mcp_servers.flight_browser.tools.browser_press]
approval_mode = "approve"
[mcp_servers.flight_browser.tools.browser_select]
approval_mode = "approve"
[mcp_servers.flight_browser.tools.browser_wait]
approval_mode = "approve"
[mcp_servers.flight_browser.tools.browser_read_more]
approval_mode = "approve"
[mcp_servers.flight_browser.tools.browser_captcha_inspect]
approval_mode = "approve"
[mcp_servers.flight_browser.tools.browser_captcha_act]
approval_mode = "approve"
[mcp_servers.flight_browser.env]
FLIGHT_BROWSER_SETTINGS = ${toml(JSON.stringify(settings))}
${process.env.PLAYWRIGHT_BROWSERS_PATH ? `PLAYWRIGHT_BROWSERS_PATH = ${toml(process.env.PLAYWRIGHT_BROWSERS_PATH)}` : ''}
`, { mode: 0o600 });
    const schemaFile = join(base, 'schema.json'), outputFile = join(base, 'result.json');
    await writeFile(schemaFile, JSON.stringify(outputSchema), { mode: 0o600 });
    const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
      '--color', 'never', '--output-schema', schemaFile, '-o', outputFile, '-C', work, '-'];
    // Pass only service-owned variables; never inherit Miaoda/API keys, personal tools or arbitrary config.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR, LANG: 'C.UTF-8', CODEX_HOME: home, CODEX_API_KEY: this.config.modelApiKey,
      ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}) };
    let stopped = false;
    try {
      await new Promise<void>((resolveRun, reject) => {
        const child = spawn(this.config.codexBin, args, { env, cwd: work, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', shell: false });
        let timedOut = false, tooLarge = false, bytes = 0, fatal = false, killed: NodeJS.Timeout | undefined;
        const stop = () => {
          if (stopped) return; stopped = true;
          const kill = (s: NodeJS.Signals) => { try { if (child.pid) process.platform === 'win32' ? child.kill(s) : process.kill(-child.pid, s); } catch { /* Already exited. */ } };
          kill('SIGTERM'); killed = setTimeout(() => kill('SIGKILL'), 3000); killed.unref();
        };
        const timeout = setTimeout(() => { timedOut = true; stop(); }, this.config.jobTimeoutMs);
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
        const rl = createInterface({ input: child.stdout });
        let lastStage = '';
        rl.on('line', line => {
          bytes += Buffer.byteLength(line);
          if (bytes > 8_000_000) { tooLarge = true; stop(); return; }
          try {
            const event = JSON.parse(line);
            if (event.type === 'turn.failed' || event.type === 'error') fatal = true;
            if (event.type === 'item.started' && event.item?.type === 'mcp_tool_call') {
              const tool = String(event.item.tool ?? '');
              const stage = tool.startsWith('browser_captcha_') ? '正在识别并处理官网验证码' : tool === 'browser_open' ? '正在访问查询入口或航司官网' : tool === 'browser_fill' || tool === 'browser_click'
                ? '正在操作官网查询' : '正在读取运输记录与证据';
              if (stage !== lastStage) { progress(stage); lastStage = stage; }
            }
          } catch { /* Non-JSON output cannot become a result or public log. */ }
        });
        child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 8_000_000) { tooLarge = true; stop(); } });
        child.stdin.on('error', () => undefined);
        child.stdin.end(buildPrompt(job.mawb));
        const cleanup = () => { clearTimeout(timeout); if (killed) clearTimeout(killed); signal.removeEventListener('abort', stop); rl.close(); };
        child.once('error', () => { cleanup(); reject(new ExecutionError('codex_start_failed', false)); });
        child.once('close', code => {
          cleanup();
          if (signal.aborted) reject(new ExecutionError('cancelled', false));
          else if (timedOut) reject(new ExecutionError('query_timeout', true));
          else if (tooLarge) reject(new ExecutionError('output_limit', false));
          else if (code !== 0 || fatal) reject(new ExecutionError('codex_failed', true));
          else resolveRun();
        });
      });
      const rawText = await readFile(outputFile, 'utf8').catch(() => { throw new ExecutionError('missing_result', true); });
      if (rawText.length > 1_000_000) throw new ExecutionError('output_limit', false);
      let raw: unknown;
      try { raw = JSON.parse(rawText); } catch { throw new ExecutionError('invalid_json', true); }
      const evidence = await readEvidence(evidenceDir, signingKey, job.id, job.attempt);
      await this.publishEvidence(job, evidence, evidenceDir);
      return { raw, evidence };
    } catch (error) {
      // Preserve real partial lookup evidence even when execution times out or is cancelled.
      const evidence = await readEvidence(evidenceDir, signingKey, job.id, job.attempt);
      await this.publishEvidence(job, evidence, evidenceDir);
      throw error;
    } finally {
      // Contains temporary model config, signed evidence and potentially raw model output.
      await rm(base, { recursive: true, force: true });
    }
  }
  private async publishEvidence(job: Job, evidence: Evidence[], sourceDir: string) {
    const dest = join(this.config.dataDir, 'evidence', job.id, String(job.attempt));
    await mkdir(dest, { recursive: true, mode: 0o700 });
    for (const entry of evidence) {
      await writeFile(join(dest, `${entry.id}.json`), JSON.stringify(entry), { mode: 0o600 });
      if (entry.screenshot) await copyFile(join(sourceDir, `${entry.id}.png`), join(dest, `${entry.id}.png`));
    }
  }
}
