// Local development without Docker: API with in-memory store + inline search
// queue (snapshotted to .dev/store.json), and the Vite dev server for the front.
import { spawn } from 'node:child_process';

const procs = ['@way/api', '@way/front'].map((w) =>
  spawn(`npm run dev -w ${w}`, { stdio: 'inherit', shell: true }),
);
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => { if (code) { stop(); process.exit(code); } }));
