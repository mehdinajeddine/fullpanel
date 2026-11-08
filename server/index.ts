import { createApp } from './app.js';

const mode = process.env.HARBORLIGHT_MODE;
if (mode && mode !== 'docker' && mode !== 'demo') throw new Error('HARBORLIGHT_MODE must be docker or demo.');
const app = await createApp({ logger: true });
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
await app.listen({ host: process.env.HOST || '127.0.0.1', port });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); }); });
