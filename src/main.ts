import { readConfig } from './config.js';
import { Store } from './store.js';
import { createApp } from './api.js';
const config = readConfig(), store = new Store(config), app = createApp(config, store);
async function close() { await app.close(); store.close(); }
process.once('SIGTERM', () => void close()); process.once('SIGINT', () => void close());
await app.listen({ host: config.host, port: config.port });
