/**
 * 兼容旧命令：node scripts/build-userscript.mjs
 * 现在由 scripts/build.mjs 统一生成三份产物（含 v3_optimized.user.js）。
 */

import { buildAll } from './build.mjs';

const written = buildAll();
for (const path of written) {
    console.log(`已生成 ${path.split(/[\\/]/).pop()}`);
}
