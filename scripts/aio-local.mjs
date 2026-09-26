// Runs the single-container setup locally (after `npm run build:front`):
// embedded Postgres in .dev/aio, front served by the API on :8080.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

spawn('node', ['--import', 'tsx', 'apps/api/src/main.ts'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DATA_DIR: resolve('.dev/aio'),
    STATIC_DIR: resolve('apps/front/dist'),
    API_PORT: '8080',
    MEMORY_STORE_FILE: '',
  },
}).on('exit', (code) => process.exit(code ?? 0));
