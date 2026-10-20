/**
 * 产物校验（零依赖）：
 * 1) 内存重新生成三份产物，与磁盘内容逐字节比对；
 * 2) 用 vm.Script 对每份产物做语法校验（不启动子进程，避免沙箱命名管道限制）；
 * 3) 额外检查油猴元数据块与 xuexitongMain 包裹约束。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

import { artifacts } from './build.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USER_SCRIPT_MARKER = '// ==/UserScript==\n\n';

/** 语法校验：把产物当作普通脚本编译（不执行）。 */
function checkSyntax(source, filename) {
    try {
        new Script(source, { filename });
    } catch (error) {
        throw new Error(`${filename} 语法错误：${error.message}`);
    }
}

/** 校验产物与源码同步；不一致时抛错。返回校验过的文件数。 */
export function verifyArtifacts() {
    const problems = [];
    let checked = 0;

    for (const [path, factory] of artifacts()) {
        const relative = path.slice(ROOT.length + 1);
        if (!existsSync(path)) {
            problems.push(`${relative}：产物不存在，请先运行 node scripts/build.mjs`);
            continue;
        }
        const onDisk = readFileSync(path, 'utf8');
        const expected = factory();
        if (onDisk !== expected) {
            problems.push(`${relative}：产物与 src/ 源码不一致，请重新运行 node scripts/build.mjs`);
            continue;
        }
        try {
            checkSyntax(onDisk, relative);
        } catch (error) {
            problems.push(error.message);
            continue;
        }
        checked += 1;
    }

    const userScriptPath = resolve(ROOT, 'v3_optimized.user.js');
    if (existsSync(userScriptPath)) {
        const content = readFileSync(userScriptPath, 'utf8');
        if (!content.startsWith('// ==UserScript==')) {
            problems.push('v3_optimized.user.js：文件必须以 // ==UserScript== 开头');
        }
        const index = content.indexOf(USER_SCRIPT_MARKER);
        if (index < 0) {
            problems.push('v3_optimized.user.js：缺少 // ==/UserScript== 元数据块');
        } else {
            const payload = content.slice(index + USER_SCRIPT_MARKER.length);
            const source = readFileSync(resolve(ROOT, 'v3_optimized.js'), 'utf8');
            if (payload !== source) {
                problems.push('v3_optimized.user.js：负载与 v3_optimized.js 不一致');
            }
        }
    }

    const consolePath = resolve(ROOT, 'deepseek-console/xuexitong-console.js');
    if (existsSync(consolePath)) {
        const content = readFileSync(consolePath, 'utf8');
        if (!/\(function xuexitongMain\s*\(/.test(content)) {
            problems.push('xuexitong-console.js：必须由单个具名函数 xuexitongMain 包裹');
        }
        if (/@@INCLUDE:/.test(content)) {
            problems.push('xuexitong-console.js：仍有未展开的 @@INCLUDE@@ 标记');
        }
        if (/__LOCAL_TOKEN__/.test(content) === false) {
            problems.push('xuexitong-console.js：缺少 LOCAL_TOKEN 占位符 __LOCAL_TOKEN__');
        }
    }

    if (problems.length) {
        throw new Error(`产物校验失败：\n- ${problems.join('\n- ')}`);
    }
    return checked;
}
