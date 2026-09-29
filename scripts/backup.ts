import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
const source = resolve(process.env.DATA_DIR ?? './runtime', 'service.sqlite');
const target = process.argv[2];
if (!target) throw new Error('Supply a new absolute backup file path.');
const db = new DatabaseSync(source);
db.prepare('VACUUM INTO ?').run(resolve(target));
db.close(); console.log('Consistent SQLite snapshot created. Back up the evidence directory separately while the worker is stopped.');
