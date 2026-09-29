import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { CodexRunner, ExecutionError } from '../src/runtime/runner.js';
import { fixture } from './helpers.js';

test('runner uses fixed schema, isolated config and preapproved bounded tools without inheriting service secrets', async () => {
  const f = fixture(), store = new Store(f.config);
  try {
    const bin = join(f.config.dataDir, 'fake-codex.cjs');
    await writeFile(bin, `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path');
const args=process.argv.slice(2), config=fs.readFileSync(path.join(process.env.CODEX_HOME,'config.toml'),'utf8');
if(process.env.SERVICE_API_KEYS || process.env.FLIGHT_SERVICE_KEY || !config.includes('shell_tool = false') || !config.includes('approval_mode = "approve"') || !args.includes('--output-schema')) process.exit(4);
for(const tool of ['browser_captcha_inspect','browser_captcha_act']) if(!config.includes('[mcp_servers.flight_browser.tools.'+tool+']\\napproval_mode = "approve"')) process.exit(6);
let prompt='';process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',()=>{
 if(!prompt.includes('176-12345678') || prompt.includes('not-a-real-model-key')) process.exit(5);
 console.log(JSON.stringify({type:'item.started',item:{type:'mcp_tool_call',tool:'browser_open'}}));
 console.log(JSON.stringify({type:'item.started',item:{type:'mcp_tool_call',tool:'browser_captcha_inspect'}}));
 fs.writeFileSync(args[args.indexOf('-o')+1],JSON.stringify({mawb:'176-12345678',status:'blocked'}));
});
`, { mode: 0o700 });
    f.config.codexBin = bin;
    store.createBatch('test', 'runner-test', ['176-12345678']); const job = store.claim('worker')!;
    const stages: string[] = [];
    const result = await new CodexRunner(f.config).run(job, new AbortController().signal, stage => stages.push(stage));
    assert.equal((result.raw as any).mawb, job.mawb); assert.ok(stages.length);
    assert.ok(stages.includes('正在识别并处理官网验证码'));
    assert.deepEqual(await readdir(join(f.config.dataDir, 'runs', job.id)), []);
  } finally { store.close(); f.cleanup(); }
});
test('timeout terminates Codex process and clears temporary session configuration', async () => {
  const f = fixture(), store = new Store(f.config);
  try {
    const bin = join(f.config.dataDir, 'fake-codex.cjs');
    await writeFile(bin, '#!/usr/bin/env node\nprocess.stdin.resume();setInterval(()=>{},1000);\n', { mode: 0o700 });
    f.config.codexBin = bin; f.config.jobTimeoutMs = 150;
    store.createBatch('test', 'timeout-test', ['176-12345678']); const job = store.claim('worker')!;
    await assert.rejects(new CodexRunner(f.config).run(job, new AbortController().signal, () => {}), (e: unknown) => e instanceof ExecutionError && e.code === 'query_timeout');
    assert.deepEqual(await readdir(join(f.config.dataDir, 'runs', job.id)), []);
  } finally { store.close(); f.cleanup(); }
});
