import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('secrets', { recursive: true, mode: 0o700 });
for (const [name, content] of [
  ['service-api-keys.json', JSON.stringify({ miaoda: randomBytes(32).toString('hex') }, null, 2) + '\n'],
  ['model-api-key.txt', ''],
] as const) {
  try { await writeFile(`secrets/${name}`, content, { mode: 0o600, flag: 'wx' }); console.log(`Created secrets/${name}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; console.log(`Preserved secrets/${name}`); }
}
console.log('将模型 API Key 写入 secrets/model-api-key.txt；不要提交 secrets/。服务凭证已生成，未在终端回显。');
