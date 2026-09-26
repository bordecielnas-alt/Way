// Downloads historical border snapshots into data/borders (dev). The server
// does this by itself at startup in single-container mode.
import { ensureBorders, loadConfig } from '@way/core';

const cfg = loadConfig();
const n = await ensureBorders(cfg.bordersDir, cfg.userAgent);
console.log(`${n} snapshot(s) downloaded into ${cfg.bordersDir}`);
