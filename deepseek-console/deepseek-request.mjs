/**
 * DeepSeek 接口层：把题目发过去，拿回每题选项字母。
 *
 * 可用环境变量（都可不设，默认值面向官方 api.deepseek.com）：
 *   DEEPSEEK_API_KEY      API Key（由本地服务读取，本模块不直接读）
 *   DEEPSEEK_BASE_URL     默认 https://api.deepseek.com
 *   DEEPSEEK_MODEL        默认 deepseek-chat；换 deepseek-reasoner 时自动关闭 JSON 模式
 *   DEEPSEEK_MAX_TOKENS   默认 8000
 *   DEEPSEEK_TIMEOUT_MS   默认 120000
 *
 * 约定：只使用 DeepSeek 官方文档里的参数（model / messages / max_tokens /
 * temperature / response_format / stream）。不要加 thinking、reasoning_effort
 * 这类仅第三方网关支持的字段，否则官方接口会直接返回 400。
 */

const RAW_BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').trim();

/** 去掉结尾斜杠，兼容用户填成 .../v1 或 .../v1/ 的形式。 */
export const API_BASE_URL = RAW_BASE_URL.replace(/\/+$/, '');
export const API_URL = `${API_BASE_URL}/chat/completions`;
export const MODEL = (process.env.DEEPSEEK_MODEL || 'deepseek-chat').trim();
export const MAX_TOKENS = toPositiveInt(process.env.DEEPSEEK_MAX_TOKENS, 8000);
export const REQUEST_TIMEOUT_MS = toPositiveInt(process.env.DEEPSEEK_TIMEOUT_MS, 120000);
/** 重试前等待时间（毫秒）；测试时可设为 0。 */
export const RETRY_DELAY_MS = toNonNegativeInt(process.env.DEEPSEEK_RETRY_DELAY_MS, 1000);

/** 推理模型不支持 response_format=json_object，也不接受 temperature。 */
export const IS_REASONER = /reasoner/i.test(MODEL);

const SYSTEM_PROMPT = [
    '按题意回答全部题目。注意：题干或选项可能经过网页防复制处理，出现个别汉字被替换、插入无关字，或词语看起来不通顺。',
    '先结合上下文和选项在内部还原最可能的原句，再按还原后的题意作答；不要把明显异常的替换字当作专业术语，也不要因无法逐字还原而放弃。',
    '每题都必须给非空答案，只用该题提供的选项字母且不可重复；单选题和判断题选一个，多选题列出所有正确项。',
    '不确定时选最可能的答案。id 必须对应题号。',
    '只输出 JSON：{"answers":[{"id":1,"letters":["A"]}]}。',
].join('');

/** 可重试的 HTTP 状态码：限流与服务端错误。 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** 明确的配置/额度类错误：重试没有意义，直接把原因说清楚。 */
const STATUS_HINTS = new Map([
    [400, '请求参数被 DeepSeek 拒绝（若自定义了 DEEPSEEK_MODEL，请确认该模型存在且支持 JSON 输出）'],
    [401, 'API Key 无效或已被吊销，请重新设置 DEEPSEEK_API_KEY'],
    [402, '账户余额不足，请到 platform.deepseek.com 充值后重试'],
    [403, 'API Key 没有访问该模型的权限'],
    [404, '接口路径不存在，请检查 DEEPSEEK_BASE_URL 是否填写正确'],
    [422, '请求内容不合法，通常是题目数据异常'],
]);

function toPositiveInt(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toNonNegativeInt(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 带上状态码与是否可重试标记的错误。 */
export class DeepSeekError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'DeepSeekError';
        this.status = options.status ?? null;
        this.retryable = Boolean(options.retryable);
    }
}

function errorMessageFromPayload(data) {
    if (!data) return '';
    const raw = data.error ?? data.message ?? data;
    if (typeof raw === 'string') return raw;
    if (raw && typeof raw.message === 'string') return raw.message;
    return '';
}

/** 从模型输出里取出 JSON：兼容 ```json 代码块和前后多余文字。 */
export function parseAnswerPayload(content, expectedCount) {
    const text = String(content ?? '').trim();
    if (!text) throw new DeepSeekError('DeepSeek 返回内容为空', { retryable: true });

    const candidates = [];
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) candidates.push(fenced[1].trim());
    candidates.push(text);
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));

    let parsed = null;
    for (const candidate of candidates) {
        try {
            parsed = JSON.parse(candidate);
            break;
        } catch {
            /* 换下一个候选 */
        }
    }
    if (!parsed || !Array.isArray(parsed.answers)) {
        throw new DeepSeekError('DeepSeek 返回的不是预期的 JSON（缺少 answers 数组）', { retryable: true });
    }
    if (parsed.answers.length !== expectedCount) {
        throw new DeepSeekError(
            `DeepSeek 返回 ${parsed.answers.length} 个答案，与题目数量 ${expectedCount} 不一致`,
            { retryable: true }
        );
    }
    return parsed.answers;
}

function buildRequestBody(questions, attempt) {
    const body = {
        model: MODEL,
        stream: false,
        max_tokens: attempt.maxTokens,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify(questions) },
        ],
    };
    if (attempt.jsonMode && !IS_REASONER) body.response_format = { type: 'json_object' };
    if (!IS_REASONER) body.temperature = attempt.temperature;
    return body;
}

async function callOnce(questions, apiKey, attempt, fetchImpl) {
    const timeout = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        : undefined;

    let response;
    try {
        response = await fetchImpl(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(buildRequestBody(questions, attempt)),
            signal: timeout,
        });
    } catch (error) {
        const message = error && error.name === 'TimeoutError'
            ? `请求超时（${REQUEST_TIMEOUT_MS} ms）`
            : `网络请求失败：${error && error.message ? error.message : error}`;
        throw new DeepSeekError(message, { retryable: true });
    }

    const data = await response.json().catch(() => null);

    if (!response.ok) {
        const detail = errorMessageFromPayload(data);
        const hint = STATUS_HINTS.get(response.status);
        const parts = [`DeepSeek API 返回 HTTP ${response.status}`];
        if (hint) parts.push(hint);
        if (detail) parts.push(detail);
        throw new DeepSeekError(parts.join('；'), {
            status: response.status,
            retryable: RETRYABLE_STATUS.has(response.status),
        });
    }

    const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
    const reason = choice && choice.finish_reason;
    if (reason === 'length') {
        const used = data && data.usage ? data.usage.completion_tokens : '未知';
        throw new DeepSeekError(
            `DeepSeek 输出达到长度上限（已生成 ${used} tokens）。可尝试调大 DEEPSEEK_MAX_TOKENS 或减少一次提交的题目数量`,
            { retryable: true }
        );
    }
    if (reason !== 'stop') {
        throw new DeepSeekError(`DeepSeek 未正常结束（finish_reason=${reason ?? '缺失'}）`, { retryable: true });
    }

    const answers = parseAnswerPayload(choice.message ? choice.message.content : '', questions.length);
    return { answers, usage: (data && data.usage) || null };
}

/**
 * 请求全部题目的答案。
 *
 * @param {Array<object>} questions 题号/题型/题干/选项
 * @param {string} apiKey DeepSeek API Key
 * @param {Function} [fetchImpl] 便于测试注入
 * @returns {Promise<Array<{id:number, letters:string[]}>>}
 */
export async function requestAnswers(questions, apiKey, fetchImpl = fetch) {
    if (!Array.isArray(questions) || questions.length === 0) {
        throw new DeepSeekError('没有可提交的题目', { status: 400, retryable: false });
    }
    if (!apiKey) {
        throw new DeepSeekError('缺少 DeepSeek API Key', { status: 401, retryable: false });
    }

    const attempts = [
        { label: '标准模式', maxTokens: MAX_TOKENS, temperature: 0, jsonMode: true },
        { label: '兼容模式（无 response_format）', maxTokens: MAX_TOKENS, temperature: 0, jsonMode: false },
    ];

    let lastError = null;
    for (const [index, attempt] of attempts.entries()) {
        try {
            const { answers } = await callOnce(questions, apiKey, attempt, fetchImpl);
            return answers;
        } catch (error) {
            lastError = error;
            if (!(error instanceof DeepSeekError) || !error.retryable) throw error;
            const hasNext = index + 1 < attempts.length;
            if (!hasNext) break;
            console.warn(`${error.message}；改用${attempts[index + 1].label}重试一次`);
            if (RETRY_DELAY_MS > 0) await sleep(RETRY_DELAY_MS * (index + 1));
        }
    }

    throw new DeepSeekError(
        `${lastError ? lastError.message : '未知错误'}；重试后仍未获得完整答案，本次没有选择或提交任何题目`,
        { status: lastError ? lastError.status : null, retryable: false }
    );
}
