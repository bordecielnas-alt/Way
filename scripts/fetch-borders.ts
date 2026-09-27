// Downloads the border data (dev): yearly borders from Cliopatria, then the
// older snapshots. The image builds the first at build time; the server
// fetches the second by itself in single-container mode.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureBorders, loadConfig } from '@way/core';

execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./build-cliopatria.ts', import.meta.url))], { stdio: 'inherit' });
const cfg = loadConfig();
const n = await ensureBorders(cfg.bordersDir, cfg.userAgent);
console.log(`${n} snapshot(s) downloaded into ${cfg.bordersDir}`);
