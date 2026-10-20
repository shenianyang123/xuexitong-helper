import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp, applyToken, validQuestions } from '../deepseek-console/deepseek-local.mjs';

const TOKEN = 'test-token-0123456789';
const PAGE_ORIGIN = 'https://mooc1.chaoxing.com';
const DEFAULT_ORIGIN = 'https://api.deepseek.com';

const QUESTION = {
    id: 1,
    type: '单选题',
    question: '1 + 1 等于几？',
    options: [
        { letter: 'A', text: '1' },
        { letter: 'B', text: '2' },
        { letter: 'C', text: '3' },
    ],
};

const ANSWERS = [{ id: 1, letters: ['B'] }];

const ANSWER_PAYLOAD = {
    choices: [
        {
            finish_reason: 'stop',
            message: {
                content: JSON.stringify({ answers: ANSWERS }),
            },
        },
    ],
};

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

/** 起一个真实 HTTP 服务（随机端口），并把发往 DeepSeek 的 fetch 换成桩。 */
async function withServer(run, { deepseekFetch } = {}) {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
        const target = String(url);
        if (target.startsWith(DEFAULT_ORIGIN)) {
            calls.push({ url: target, body: init && init.body ? JSON.parse(init.body) : null });
            return deepseekFetch ? deepseekFetch(target, init) : jsonResponse(ANSWER_PAYLOAD);
        }
        return originalFetch(url, init);
    };

    const server = createApp('sk-test-key', TOKEN);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = (path, options) => globalThis.fetch(base + path, options);

    try {
        await run({ base, calls, send });
    } finally {
        await new Promise((resolve) => server.close(resolve));
        globalThis.fetch = originalFetch;
    }
}

const authedHeaders = (extra = {}) => ({
    origin: PAGE_ORIGIN,
    'x-xuexitong-token': TOKEN,
    ...extra,
});

test('拒绝非学习通来源', async () => {
    await withServer(async ({ send }) => {
        const response = await send('/health', {
            headers: { origin: 'https://evil.example.com', 'x-xuexitong-token': TOKEN },
        });
        assert.equal(response.status, 403);
        assert.match(await response.text(), /Origin not allowed/);
    });
});

test('拒绝无令牌和令牌不匹配的请求', async () => {
    await withServer(async ({ send }) => {
        const noToken = await send('/health', { headers: { origin: PAGE_ORIGIN } });
        assert.equal(noToken.status, 403);
        assert.match((await noToken.json()).error, /令牌不匹配/);

        const wrongToken = await send('/health', {
            headers: { origin: PAGE_ORIGIN, 'x-xuexitong-token': 'wrong' },
        });
        assert.equal(wrongToken.status, 403);
    });
});

test('预检请求返回 CORS 头（含私有网络）', async () => {
    await withServer(async ({ send }) => {
        const response = await send('/answer', { method: 'OPTIONS', headers: { origin: PAGE_ORIGIN } });
        assert.equal(response.status, 204);
        assert.equal(response.headers.get('access-control-allow-origin'), PAGE_ORIGIN);
        assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
        assert.match(response.headers.get('access-control-allow-headers'), /X-Xuexitong-Token/i);
    });
});

test('/health 返回模型信息', async () => {
    await withServer(async ({ send }) => {
        const response = await send('/health', { headers: authedHeaders() });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.ok, true);
        assert.equal(typeof body.model, 'string');
        assert.equal(body.base, DEFAULT_ORIGIN);
    });
});

test('/answer 仅接受 JSON', async () => {
    await withServer(async ({ send }) => {
        const response = await send('/answer', {
            method: 'POST',
            headers: authedHeaders({ 'content-type': 'text/plain' }),
            body: '{}',
        });
        assert.equal(response.status, 415);
    });
});

test('/answer 正常返回答案且只发送官方请求参数', async () => {
    await withServer(async ({ send, calls }) => {
        const response = await send('/answer', {
            method: 'POST',
            headers: authedHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ questions: [QUESTION] }),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { answers: ANSWERS });

        assert.equal(calls.length, 1);
        const body = calls[0].body;
        assert.equal(body.model, 'deepseek-chat');
        assert.equal(body.thinking, undefined);
        assert.equal(body.reasoning_effort, undefined);
        assert.deepEqual(body.response_format, { type: 'json_object' });
    });
});

test('/answer 题目格式不正确时返回 502 且不请求 DeepSeek', async () => {
    await withServer(async ({ send, calls }) => {
        const tooMany = Array.from({ length: 31 }, (_, i) => ({ ...QUESTION, id: i + 1 }));
        const response = await send('/answer', {
            method: 'POST',
            headers: authedHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ questions: tooMany }),
        });
        assert.equal(response.status, 502);
        assert.match((await response.json()).error, /题目格式不正确/);
        assert.equal(calls.length, 0);
    });
});

test('/answer 上游 Key 无效时返回 502 和可读原因', async () => {
    await withServer(
        async ({ send }) => {
            const response = await send('/answer', {
                method: 'POST',
                headers: authedHeaders({ 'content-type': 'application/json' }),
                body: JSON.stringify({ questions: [QUESTION] }),
            });
            assert.equal(response.status, 502);
            assert.match((await response.json()).error, /API Key 无效/);
        },
        {
            deepseekFetch: () =>
                jsonResponse({ error: { message: 'Authentication Fails', type: 'authentication_error' } }, 401),
        }
    );
});

test('applyToken 只替换占位符，并校验占位符存在', () => {
    const source = 'var LOCAL_TOKEN = "__LOCAL_TOKEN__";\nvar LOCAL_URL = "http://127.0.0.1:37841";';
    const ready = applyToken(source, 'abc123');
    assert.match(ready, /var LOCAL_TOKEN = "abc123";/);
    assert.ok(!ready.includes('__LOCAL_TOKEN__'));
    assert.match(ready, /http:\/\/127\.0\.0\.1:37841/);
    assert.throws(() => applyToken('var x = 1;', 'abc123'), /占位符/);
});

test('applyToken 会把自定义端口写进 LOCAL_URL', () => {
    const source = 'var LOCAL_TOKEN = "__LOCAL_TOKEN__";\nvar LOCAL_URL = "http://127.0.0.1:37841";';
    const ready = applyToken(source, 'abc123', 39001);
    assert.match(ready, /var LOCAL_URL = "http:\/\/127\.0\.0\.1:39001"/);
});

test('validQuestions 校验题目结构', () => {
    assert.equal(validQuestions([QUESTION]), true);
    assert.equal(validQuestions([]), false);
    assert.equal(validQuestions(null), false);
    assert.equal(validQuestions([{ ...QUESTION, options: [] }]), false);
    assert.equal(validQuestions([{ ...QUESTION, id: 2 }]), false);
    assert.equal(validQuestions([{ ...QUESTION, type: '填空题' }]), false);
});
