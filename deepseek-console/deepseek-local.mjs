/**
 * DeepSeek 本地答题服务（只监听 127.0.0.1）。
 *
 * 启动：双击 start-local-service.cmd，或在本目录执行 `node deepseek-local.mjs`。
 *
 * API Key 取用顺序：
 *   1) 环境变量 DEEPSEEK_API_KEY
 *   2) 同目录 .env.local 里的 DEEPSEEK_API_KEY=...（首次输入后会自动写入，只写一次）
 *   3) 交互输入（输入内容不会显示）
 *
 * 令牌机制：
 *   每次启动生成/复用 .local-token，并据此生成 xuexitong-console.ready.js。
 *   xuexitong-console.js 是构建产物，本服务**永不修改它**；
 *   你只需要把 ready 文件的内容粘贴到学习通页面的控制台。
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';

import { requestAnswers, MODEL, API_BASE_URL, IS_REASONER, DeepSeekError } from './deepseek-request.mjs';

const DEFAULT_PORT = 37841;
const PORT = Number.parseInt(process.env.XUEXITONG_PORT || String(DEFAULT_PORT), 10);
const DIR = fileURLToPath(new URL('.', import.meta.url));
const scriptPath = resolve(DIR, 'xuexitong-console.js');
const readyPath = resolve(DIR, 'xuexitong-console.ready.js');
const envPath = resolve(DIR, '.env.local');
const tokenPath = resolve(DIR, '.local-token');

const allowedOrigin = (origin) => /^https:\/\/([a-z0-9-]+\.)*chaoxing\.com$/i.test(origin || '');

/* ------------------------------ API Key ------------------------------ */

function readEnvFile() {
    if (!existsSync(envPath)) return {};
    const result = {};
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
    return result;
}

function saveEnvFile(key) {
    const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
    const lines = existing
        .split(/\r?\n/)
        .filter((line) => line.trim() && !/^\s*DEEPSEEK_API_KEY\s*=/.test(line));
    lines.push(`DEEPSEEK_API_KEY=${key}`);
    writeFileSync(envPath, `${lines.join('\n')}\n`, 'utf8');
}

async function promptApiKey() {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const value = await rl.question('DeepSeek API Key: ');
        rl.close();
        return value.trim();
    }
    process.stdout.write('请粘贴 DeepSeek API Key 后按 Enter（输入不显示；只需输入这一次）：');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    return new Promise((resolvePromise, reject) => {
        let value = '';
        const onData = (chunk) => {
            for (const char of chunk) {
                if (char === '\r' || char === '\n') {
                    process.stdin.off('data', onData);
                    process.stdin.setRawMode(false);
                    process.stdin.pause();
                    process.stdout.write('\n');
                    resolvePromise(value.trim());
                    return;
                }
                if (char === '\u0003') {
                    process.stdin.off('data', onData);
                    process.stdin.setRawMode(false);
                    reject(new Error('已取消'));
                    return;
                }
                if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
                else value += char;
            }
        };
        process.stdin.on('data', onData);
    });
}

async function resolveApiKey() {
    const fromEnv = (process.env.DEEPSEEK_API_KEY || '').trim();
    if (fromEnv) {
        console.log('已从环境变量 DEEPSEEK_API_KEY 读取 API Key');
        return fromEnv;
    }
    const fromFile = (readEnvFile().DEEPSEEK_API_KEY || '').trim();
    if (fromFile) {
        console.log(`已从 ${'.env.local'} 读取 API Key`);
        return fromFile;
    }
    const typed = await promptApiKey();
    if (!typed) throw new Error('未输入 DeepSeek API Key');
    if (typed.startsWith('sk-') || typed.length >= 20) {
        saveEnvFile(typed);
        console.log(`API Key 已保存到 ${envPath}（该文件已被 .gitignore 忽略），以后启动无需再输入。`);
    } else {
        console.warn('输入的 Key 看起来不像 DeepSeek 的 sk- 格式，仍按原样使用。');
    }
    return typed;
}

/** 用免费的 GET /models 校验 Key，失败只警告不阻塞。 */
async function checkApiKey(apiKey) {
    const url = `${API_BASE_URL}/models`;
    try {
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
        });
        if (response.ok) {
            console.log(`API Key 校验通过（${MODEL}）`);
            return true;
        }
        if (response.status === 401) {
            console.warn('警告：API Key 校验失败（401，Key 无效）。服务仍会启动，但答题会失败。');
        } else if (response.status === 402) {
            console.warn('警告：账户余额不足（402）。服务仍会启动，但答题会失败。');
        } else {
            console.warn(`警告：API Key 校验返回 HTTP ${response.status}，继续启动。`);
        }
    } catch (error) {
        console.warn(`警告：无法连接 ${API_BASE_URL} 校验 Key（${error.message}）。请检查网络或代理设置。`);
    }
    return false;
}

/* ------------------------------- token ------------------------------- */

function resolveToken() {
    if (process.env.XUEXITONG_TOKEN) return process.env.XUEXITONG_TOKEN.trim();
    if (existsSync(tokenPath)) {
        const saved = readFileSync(tokenPath, 'utf8').trim();
        if (saved.length >= 16) return saved;
    }
    const token = randomBytes(24).toString('hex');
    writeFileSync(tokenPath, `${token}\n`, 'utf8');
    return token;
}

/**
 * 把真实令牌（以及自定义端口）写进控制台脚本源码。
 * 纯函数，便于测试。
 */
export function applyToken(source, token, port = PORT) {
    if (!/LOCAL_TOKEN\s*=\s*["']__LOCAL_TOKEN__["']/.test(source)) {
        throw new Error('控制台脚本缺少令牌占位符 __LOCAL_TOKEN__');
    }
    const withToken = source.replace(
        /(LOCAL_TOKEN\s*=\s*)["']__LOCAL_TOKEN__["']/,
        (_match, prefix) => `${prefix}"${token}"`
    );
    if (port === DEFAULT_PORT) return withToken;
    return withToken.replace(
        /(LOCAL_URL\s*=\s*["'])http:\/\/127\.0\.0\.1:\d+(["'])/,
        (_match, prefix, suffix) => `${prefix}http://127.0.0.1:${port}${suffix}`
    );
}

/** 生成 ready 文件（含真实令牌），永不修改构建产物。 */
function writeReadyScript(token) {
    const source = readFileSync(scriptPath, 'utf8');
    const ready = applyToken(source, token);
    writeFileSync(readyPath, ready, 'utf8');
    return readyPath;
}

/* ------------------------------- HTTP -------------------------------- */

function send(res, status, data, origin) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': origin,
        Vary: 'Origin',
    });
    res.end(JSON.stringify(data));
}

export function validQuestions(questions) {
    if (!Array.isArray(questions) || questions.length < 1 || questions.length > 30) return false;
    return questions.every((q, i) => Number.isInteger(q.id) && q.id === i + 1 &&
        ['单选题', '多选题', '判断题'].includes(q.type) &&
        typeof q.question === 'string' && q.question.length > 0 && q.question.length <= 500 &&
        Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 8 &&
        new Set(q.options.map((o) => o.letter)).size === q.options.length &&
        q.options.every((o) => /^[A-H]$/.test(o.letter) && typeof o.text === 'string' && o.text.length > 0 && o.text.length <= 500));
}

function describeError(error) {
    if (error instanceof DeepSeekError) return error.message;
    return error && error.message ? error.message : String(error);
}

let busy = false;

export function createApp(apiKey, token) {
    return createServer(async (req, res) => {
        const origin = req.headers.origin;
        if (!allowedOrigin(origin)) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Origin not allowed');
            return;
        }
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': origin,
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, X-Xuexitong-Token',
                'Access-Control-Allow-Private-Network': 'true',
                'Access-Control-Max-Age': '600',
                Vary: 'Origin',
            });
            res.end();
            return;
        }
        if (req.headers['x-xuexitong-token'] !== token) {
            send(res, 403, { error: '本地令牌不匹配：请重新复制 xuexitong-console.ready.js 的内容执行' }, origin);
            return;
        }
        if (req.method === 'GET' && req.url === '/health') {
            send(res, 200, { ok: true, model: MODEL, reasoner: IS_REASONER, base: API_BASE_URL }, origin);
            return;
        }
        if (req.method !== 'POST' || req.url !== '/answer') {
            send(res, 404, { error: '未找到接口' }, origin);
            return;
        }
        if (busy) {
            send(res, 429, { error: '上一批题目仍在处理，请稍后再试' }, origin);
            return;
        }
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
            send(res, 415, { error: '仅接受 JSON' }, origin);
            return;
        }
        busy = true;
        try {
            let raw = '';
            for await (const chunk of req) {
                raw += chunk.toString('utf8');
                if (raw.length > 100000) throw new DeepSeekError('请求内容过大', { status: 413, retryable: false });
            }
            const questions = JSON.parse(raw).questions;
            if (!validQuestions(questions)) throw new DeepSeekError('题目格式不正确', { status: 400, retryable: false });
            console.log(`收到 ${questions.length} 道题，开始请求 ${MODEL}`);
            const startedAt = Date.now();
            const answers = await requestAnswers(questions, apiKey);
            console.log(`已返回 ${answers.length} 个答案，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
            send(res, 200, { answers }, origin);
        } catch (error) {
            console.error('答题失败：', describeError(error));
            send(res, 502, { error: describeError(error) }, origin);
        } finally {
            busy = false;
        }
    });
}

/* ------------------------------- main -------------------------------- */

export async function main() {
    const apiKey = await resolveApiKey();
    const token = resolveToken();
    await checkApiKey(apiKey);

    console.log(`DeepSeek 模型：${MODEL}${IS_REASONER ? '（推理模型，已关闭 JSON 模式）' : ''}`);
    console.log(`接口地址：${API_BASE_URL}`);

    const readyFile = writeReadyScript(token);
    const server = createApp(apiKey, token);

    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            console.error(`端口 ${PORT} 已被占用：可能已经有一个本地服务在运行，请关闭旧窗口后重试。`);
        } else {
            console.error('本地服务启动失败：', error);
        }
        process.exitCode = 1;
    });

    server.listen(PORT, '127.0.0.1', () => {
        console.log('');
        console.log(`本地服务已启动：http://127.0.0.1:${PORT}`);
        console.log(`控制台脚本（含本次令牌）：${readyFile}`);
        console.log('');
        console.log('使用方法：');
        console.log('  1) 打开学习通课程播放页；');
        console.log('  2) 打开 Edge 控制台（F12），粘贴 xuexitong-console.ready.js 的全部内容并回车；');
        console.log('  3) 保持本窗口打开，直到课程刷完。');
        console.log('');
        console.log('API Key 不会写入构建产物；关闭本窗口即停止服务。');
    });

    return server;
}

const isMain = process.argv[1]
    ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
    : false;

if (isMain) {
    await main();
}
