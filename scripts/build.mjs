/**
 * 构建脚本：把 src/ 下的模块内联为可直接使用的三份入口文件。
 *
 * 用法：
 *   node scripts/build.mjs           # 生成全部产物
 *   node scripts/build.mjs --check   # 只校验磁盘产物与源码是否一致（等价于 tests/verify.mjs）
 *
 * 产物：
 *   v3_optimized.js                          —— 浏览器控制台直接粘贴执行（V3）
 *   v3_optimized.user.js                     —— 油猴脚本（V3 + 元数据头）
 *   deepseek-console/xuexitong-console.js    —— Edge 控制台版（V4，含 DeepSeek 章节测验）
 *   deepseek-console/xuexitong-console.user.js —— 油猴版（V4 + 元数据头，自动注入）
 *
 * 说明：两份 console 产物中的 LOCAL_TOKEN 固定保留为占位符 __LOCAL_TOKEN__；
 * 本地服务启动时会额外生成 xuexitong-console.ready.js 与
 * xuexitong-console.ready.user.js（已写入真实令牌），
 * 构建脚本永远不会修改或覆盖它们。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = resolve(ROOT, 'src');

export const VERSION = '3.5.7';

const INCLUDE_PATTERN = /^[ \t]*\/\* @@INCLUDE:([A-Za-z0-9._-]+)@@ \*\/[ \t]*$/gm;

const USER_SCRIPT_METADATA = `// ==UserScript==
// @name         学习通自动刷课脚本 V3 稳定版
// @namespace    local.codex.xuexitong
// @version      ${VERSION}
// @description  自动播放、多视频串联、断点续播，并在页面结构异常时安全停止
// @author       Codex
// @match        *://*.chaoxing.com/*mycourse/studentstudy*
// @match        *://chaoxing.com/*mycourse/studentstudy*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

`;

const CONSOLE_USER_METADATA = `// ==UserScript==
// @name         学习通自动刷课助手（DeepSeek 版）
// @namespace    local.codex.xuexitong
// @version      ${VERSION}
// @description  自动播放、多视频串联、断点续播、悬浮球控制，并可用本地服务自动作答章节测验
// @author       Codex
// @match        *://*.chaoxing.com/*mycourse/studentstudy*
// @match        *://chaoxing.com/*mycourse/studentstudy*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

`;

/** 读取 src/ 下的模块源码（去 BOM、统一行尾）。 */
function readModule(name) {
    const path = resolve(SRC_DIR, `${name}.js`);
    if (!existsSync(path)) throw new Error(`缺少模块源码：${path}`);
    return readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

/** 把 /* @@INCLUDE:xxx@@ *\/ 标记替换为对应模块内容。 */
export function inlineIncludes(source, origin) {
    const missing = [];
    const result = source.replace(INCLUDE_PATTERN, (match, name) => {
        try {
            return readModule(name).replace(/\n+$/, '\n');
        } catch (error) {
            missing.push(`${name}（${error.message}）`);
            return match;
        }
    });
    if (missing.length) {
        throw new Error(`${origin} 内联失败：无法读取模块 ${missing.join('、')}`);
    }
    if (INCLUDE_PATTERN.test(result)) {
        throw new Error(`${origin} 内仍有未展开的 @@INCLUDE@@ 标记`);
    }
    INCLUDE_PATTERN.lastIndex = 0;
    return result.replace(/__XXT_VERSION__/g, VERSION);
}

/** 生成 v3_optimized.js 内容（控制台版）。 */
export function buildV3() {
    const entry = readModule('entry-v3');
    return inlineIncludes(entry, 'src/entry-v3.js');
}

/** 生成 v3_optimized.user.js 内容（油猴版）。 */
export function buildUserScript() {
    return `${USER_SCRIPT_METADATA}${buildV3()}`;
}

/** 生成 deepseek-console/xuexitong-console.js 内容。 */
export function buildConsole() {
    const entry = readModule('entry-console');
    const output = inlineIncludes(entry, 'src/entry-console.js');
    if (!/\(function xuexitongMain\s*\(/.test(output)) {
        throw new Error('xuexitong-console.js 必须由单个具名函数 xuexitongMain 包裹');
    }
    if (!/const LOCAL_TOKEN = '__LOCAL_TOKEN__';/.test(output) && !/var LOCAL_TOKEN = "__LOCAL_TOKEN__";/.test(output)) {
        throw new Error('xuexitong-console.js 必须保留 LOCAL_TOKEN 占位符 __LOCAL_TOKEN__');
    }
    return output;
}

/** 生成 deepseek-console/xuexitong-console.user.js 内容（油猴版，仍含令牌占位符）。 */
export function buildConsoleUserScript() {
    const payload = buildConsole();
    return `${CONSOLE_USER_METADATA}${payload}`;
}

/** 产物清单：路径 → 生成函数。 */
export function artifacts() {
    return new Map([
        [resolve(ROOT, 'v3_optimized.js'), buildV3],
        [resolve(ROOT, 'v3_optimized.user.js'), buildUserScript],
        [resolve(ROOT, 'deepseek-console/xuexitong-console.js'), buildConsole],
        [resolve(ROOT, 'deepseek-console/xuexitong-console.user.js'), buildConsoleUserScript],
    ]);
}

export function buildAll() {
    const written = [];
    for (const [path, factory] of artifacts()) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, factory(), 'utf8');
        written.push(path);
    }
    return written;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const check = process.argv.includes('--check');
    if (check) {
        const { verifyArtifacts } = await import('./verify-core.mjs');
        verifyArtifacts();
    } else {
        const written = buildAll();
        for (const path of written) {
            console.log(`已生成 ${path.slice(ROOT.length + 1)}`);
        }
    }
}
