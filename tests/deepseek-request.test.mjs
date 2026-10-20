import assert from 'node:assert/strict';
import test from 'node:test';

// 加速重试（必须在导入被测模块前设置，模块级常量在导入时读取）
process.env.DEEPSEEK_RETRY_DELAY_MS = '0';

const request = await import('../deepseek-console/deepseek-request.mjs');

const QUESTIONS = [
    {
        id: 1,
        type: '单选题',
        question: '1+1 等于几？',
        options: [
            { letter: 'A', text: '1' },
            { letter: 'B', text: '2' },
        ],
    },
];

/** 构造一个假的 fetch：按顺序返回预设响应，并记录每次请求。 */
function makeFetch(responses) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        const next = responses[Math.min(calls.length - 1, responses.length - 1)];
        if (typeof next === 'function') return next(url, init);
        return next;
    };
    return { calls, fetchImpl };
}

function jsonResponse(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
    };
}

function completion(content, finishReason = 'stop') {
    return jsonResponse(200, {
        choices: [{ message: { content }, finish_reason: finishReason }],
        usage: { completion_tokens: 20 },
    });
}

const GOOD_ANSWER = JSON.stringify({ answers: [{ id: 1, letters: ['B'] }] });

test('默认使用官方 deepseek-chat 且不带非官方参数', async () => {
    assert.equal(request.MODEL, 'deepseek-chat');
    assert.equal(request.API_URL, 'https://api.deepseek.com/chat/completions');

    const { calls, fetchImpl } = makeFetch([completion(GOOD_ANSWER)]);
    const answers = await request.requestAnswers(QUESTIONS, 'sk-test', fetchImpl);

    assert.deepEqual(answers, [{ id: 1, letters: ['B'] }]);
    assert.equal(calls.length, 1);
    const body = calls[0].body;
    assert.equal(body.model, 'deepseek-chat');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.temperature, 0);
    assert.ok(body.max_tokens > 0);
    assert.equal(body.thinking, undefined, '不应携带 thinking 参数');
    assert.equal(body.reasoning_effort, undefined, '不应携带 reasoning_effort 参数');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
});

test('401 直接报 Key 无效且不重试', async () => {
    const { calls, fetchImpl } = makeFetch([
        jsonResponse(401, { error: { message: 'Authentication Fails' } }),
    ]);
    await assert.rejects(
        () => request.requestAnswers(QUESTIONS, 'sk-bad', fetchImpl),
        (error) => {
            assert.match(error.message, /401/);
            assert.match(error.message, /API Key 无效/);
            assert.equal(error.retryable, false);
            return true;
        }
    );
    assert.equal(calls.length, 1, '401 不应重试');
});

test('402 余额不足会被直接说明', async () => {
    const { calls, fetchImpl } = makeFetch([
        jsonResponse(402, { error: { message: 'Insufficient Balance' } }),
    ]);
    await assert.rejects(
        () => request.requestAnswers(QUESTIONS, 'sk-test', fetchImpl),
        (error) => {
            assert.match(error.message, /余额不足/);
            assert.match(error.message, /Insufficient Balance/);
            return true;
        }
    );
    assert.equal(calls.length, 1);
});

test('429 限流会重试一次，第二次关闭 JSON 模式', async () => {
    const { calls, fetchImpl } = makeFetch([
        jsonResponse(429, { error: { message: 'Rate limit reached' } }),
        completion(GOOD_ANSWER),
    ]);
    const answers = await request.requestAnswers(QUESTIONS, 'sk-test', fetchImpl);
    assert.deepEqual(answers, [{ id: 1, letters: ['B'] }]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
    assert.equal(calls[1].body.response_format, undefined, '兼容模式不应再带 response_format');
});

test('finish_reason=length 会真正重试，而不是直接失败', async () => {
    const { calls, fetchImpl } = makeFetch([
        completion('{"answers":[{"id":1,"letters":["B"]}]', 'length'),
        completion(GOOD_ANSWER),
    ]);
    const answers = await request.requestAnswers(QUESTIONS, 'sk-test', fetchImpl);
    assert.deepEqual(answers, [{ id: 1, letters: ['B'] }]);
    assert.equal(calls.length, 2);
});

test('两次都 length 时报长度上限而不是静默失败', async () => {
    const { calls, fetchImpl } = makeFetch([
        completion('{}', 'length'),
        completion('{}', 'length'),
    ]);
    await assert.rejects(
        () => request.requestAnswers(QUESTIONS, 'sk-test', fetchImpl),
        (error) => {
            assert.match(error.message, /长度上限/);
            assert.match(error.message, /没有选择或提交/);
            return true;
        }
    );
    assert.equal(calls.length, 2);
});

test('返回题目数量不一致时重试后报错', async () => {
    const bad = JSON.stringify({ answers: [] });
    const { calls, fetchImpl } = makeFetch([completion(bad), completion(bad)]);
    await assert.rejects(
        () => request.requestAnswers(QUESTIONS, 'sk-test', fetchImpl),
        /与题目数量 1 不一致/
    );
    assert.equal(calls.length, 2);
});

test('兼容 ```json 代码块与前后多余文字', async () => {
    const fenced = '这是答案：\n```json\n{"answers":[{"id":1,"letters":["A"]}]}\n```\n请查收';
    const { fetchImpl } = makeFetch([completion(fenced)]);
    const answers = await request.requestAnswers(QUESTIONS, 'sk-test', fetchImpl);
    assert.deepEqual(answers, [{ id: 1, letters: ['A'] }]);
});

test('网络错误归类为可重试', async () => {
    const { calls, fetchImpl } = makeFetch([
        () => {
            const error = new Error('fetch failed');
            error.name = 'TypeError';
            throw error;
        },
        completion(GOOD_ANSWER),
    ]);
    const answers = await request.requestAnswers(QUESTIONS, 'sk-test', fetchImpl);
    assert.deepEqual(answers, [{ id: 1, letters: ['B'] }]);
    assert.equal(calls.length, 2);
});

test('缺少 Key 或题目直接报错，不发请求', async () => {
    let called = 0;
    const fetchImpl = async () => {
        called += 1;
        return completion(GOOD_ANSWER);
    };
    await assert.rejects(() => request.requestAnswers(QUESTIONS, '', fetchImpl), /缺少 DeepSeek API Key/);
    await assert.rejects(() => request.requestAnswers([], 'sk-test', fetchImpl), /没有可提交的题目/);
    assert.equal(called, 0);
});
