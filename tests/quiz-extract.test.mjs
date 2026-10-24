import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QUIZ_SOURCE = readFileSync(resolve(ROOT, 'src/quiz-automation.js'), 'utf8');

/** 新版 mooc-ans 章节测验：选项是 radio，没有 A/B 字母，判断题只有「对 / 错」。 */
const NEW_QUIZ_HTML = `<!doctype html>
<html><head><title>章节测验</title></head>
<body>
  <div class="question">
    <div class="question-title"><span>1</span><span>【判断题】</span>
      <span>WHO认为健康不仅是没有疾病和身体的虚弱，而是一种身体上，心理上和社会上的完满状态。（）</span>
    </div>
    <ul class="options">
      <li><label><input type="radio" name="q1" value="A"><span>对</span></label></li>
      <li><label><input type="radio" name="q1" value="B"><span>错</span></label></li>
    </ul>
  </div>
  <button>暂时保存</button>
  <button>提交</button>
</body></html>`;

/** 老版页面：选项带 A/B/C 字母，不带 radio。 */
const OLD_QUIZ_HTML = `<!doctype html>
<html><head><title>章节测验</title></head>
<body>
  <div class="TiMu">
    <div class="Zy_TItle">【单选题】下列属于心理健康标准的是（）</div>
    <ul class="mark_letter">
      <li><span>A</span><span>自我认知清晰</span></li>
      <li><span>B</span><span>长期情绪低落</span></li>
      <li><span>C</span><span>回避人际交往</span></li>
    </ul>
  </div>
  <button>提交</button>
</body></html>`;

function loadQuizAutomation(html) {
    const dom = new JSDOM(html, { url: 'https://mooc1-2.chaoxing.com/mooc-ans/mycourse/studentstudy?chapterId=1', pretendToBeVisual: true });
    const { window } = dom;
    window.Element.prototype.getClientRects = function getClientRects() {
        if (!this.isConnected) return [];
        if (this.style && (this.style.display === 'none' || this.style.visibility === 'hidden')) return [];
        const rect = { x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 };
        return Object.assign([rect], { item: (index) => (index === 0 ? rect : null) });
    };
    // jsdom 没有实现 innerText，这里按 Chromium 的行为补一个（块级元素之间换行）
    const BLOCK_TAGS = new Set(['div', 'li', 'ul', 'ol', 'p', 'h1', 'h2', 'h3', 'h4', 'section', 'article', 'tr', 'table']);
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
        configurable: true,
        get() {
            const parts = [];
            const walk = (node) => {
                for (const child of node.childNodes) {
                    if (child.nodeType === 3) {
                        parts.push(child.nodeValue);
                    } else if (child.nodeType === 1) {
                        const tag = child.tagName.toLowerCase();
                        if (tag === 'br') {
                            parts.push('\n');
                            continue;
                        }
                        const block = BLOCK_TAGS.has(tag);
                        if (block) parts.push('\n');
                        walk(child);
                        if (block) parts.push('\n');
                    }
                }
            };
            walk(this);
            return parts.join('').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n+/g, '\n').trim();
        },
        set(value) {
            this.textContent = value;
        },
    });
    const saved = {
        document: globalThis.document,
        NodeFilter: globalThis.NodeFilter,
        Node: globalThis.Node,
        location: globalThis.location,
    };
    globalThis.document = window.document;
    globalThis.NodeFilter = window.NodeFilter;
    globalThis.Node = window.Node;
    globalThis.location = window.location;
    try {
        const attach = new Function(QUIZ_SOURCE + '\nreturn attachQuizAutomation;')();
        const app = {
            destroy() {},
            _note() {},
            _setStatus() {},
            _nextUnitPending: false,
        };
        attach(app);
        return { app, window, restore: () => Object.assign(globalThis, saved) };
    } catch (error) {
        Object.assign(globalThis, saved);
        throw error;
    }
}

test('新版测验：radio 选项（对/错）也能解析成 A/B', () => {
    const { app, restore } = loadQuizAutomation(NEW_QUIZ_HTML);
    try {
        assert.equal(app._quizExtract.byLetters().length, 0, '字母法不应识别出题目');
        const questions = app._quizExtract.all();
        assert.equal(questions.length, 1);
        const question = questions[0];
        assert.equal(question.kind, '判断题');
        assert.match(question.title, /^WHO认为健康不仅/);
        assert.equal(question.options.length, 2);
        assert.deepEqual(question.options.map((option) => `${option.letter}.${option.text}`), ['A.对', 'B.错']);
        assert.equal(question.options[0].element.tagName, 'LABEL');
        assert.equal(question.options[0].element.querySelector('input').type, 'radio');
    } finally {
        restore();
    }
});

test('老版测验：带字母的选项仍然走字母解析', () => {
    const { app, restore } = loadQuizAutomation(OLD_QUIZ_HTML);
    try {
        const questions = app._quizExtract.byLetters();
        assert.equal(questions.length, 1);
        assert.equal(questions[0].kind, '单选题');
        assert.deepEqual(questions[0].options.map((option) => `${option.letter}.${option.text}`), [
            'A.自我认知清晰',
            'B.长期情绪低落',
            'C.回避人际交往',
        ]);
        assert.equal(app._quizExtract.byInputs().length, 0, '没有 radio 时不应误判');
    } finally {
        restore();
    }
});

test('新版测验：多道 radio 题按 name 分组各自识别', () => {
    const html = NEW_QUIZ_HTML.replace(
        '<button>暂时保存</button>',
        `<div class="question">
      <div class="question-title"><span>2</span><span>【单选题】</span><span>心理健康的标准不包括（）</span></div>
      <ul class="options">
        <li><label><input type="radio" name="q2" value="A"><span>积极乐观</span></label></li>
        <li><label><input type="radio" name="q2" value="B"><span>自我接纳</span></label></li>
        <li><label><input type="radio" name="q2" value="C"><span>长期失眠</span></label></li>
      </ul>
    </div>
    <button>暂时保存</button>`
    );
    const { app, restore } = loadQuizAutomation(html);
    try {
        const questions = app._quizExtract.all();
        assert.equal(questions.length, 2);
        assert.deepEqual(questions.map((question) => question.kind), ['判断题', '单选题']);
        assert.deepEqual(questions[1].options.map((option) => option.letter), ['A', 'B', 'C']);
        assert.equal(questions[1].options[2].text, '长期失眠');
    } finally {
        restore();
    }
});

test('勾选答案：新版 radio 会把 input.checked 置为 true，不再误判「未确认选中」', async () => {
    const { app, window, restore } = loadQuizAutomation(NEW_QUIZ_HTML);
    try {
        const questions = app._quizExtract.all();
        assert.equal(questions.length, 1);
        await app._quizExtract.select(questions, new Map([[1, ['A']]]));
        const input = window.document.querySelector('input[name="q1"]');
        assert.equal(input.checked, true);
        assert.equal(window.document.querySelector('input[name="q1"][value="B"]').checked, false);
    } finally {
        restore();
    }
});

test('勾选答案：老版字母选项点击后由页面加上选中样式，同样判定为已选中', async () => {
    const html = OLD_QUIZ_HTML.replace('<ul class="mark_letter">', '<ul class="mark_letter"><li class="marked-none" hidden></li>');
    const { app, window, restore } = loadQuizAutomation(html);
    try {
        // 模拟平台脚本：点击选项后给所在的 li 加 active 类
        window.document.addEventListener('click', (event) => {
            const item = event.target.closest ? event.target.closest('li') : null;
            if (item) item.classList.add('active');
        });
        const questions = app._quizExtract.all();
        assert.equal(questions.length, 1);
        await app._quizExtract.select(questions, new Map([[1, ['B']]]));
        const active = Array.from(window.document.querySelectorAll('li.active'));
        assert.equal(active.length, 1);
        assert.match(active[0].textContent, /长期情绪低落/);
    } finally {
        restore();
    }
});

test('测验完成判定：成绩页文案带全角冒号（本次成绩：100 / 得分：100.0 分）也算已完成', () => {
    const scoreHtml = `<!doctype html><html><body>
        <div class="testTitle">章节测验</div>
        <div class="score">本次成绩：100</div>
        <div class="score">得分：100.0 分</div>
    </body></html>`;
    const { app, restore } = loadQuizAutomation(scoreHtml);
    try {
        assert.equal(app._quizExtract.completed(), true, '带全角冒号的成绩文案不应再判为未完成');
    } finally {
        restore();
    }
});

test('测验完成判定：只有题目、没有成绩页时不算已完成', () => {
    const { app, restore } = loadQuizAutomation(NEW_QUIZ_HTML);
    try {
        assert.equal(app._quizExtract.completed(), false, '未提交的题目页不能判为已完成');
    } finally {
        restore();
    }
});

test('下一节：页面上没有「下一节」按钮时按课程目录跳到下一小节', async () => {
    const { app, restore } = loadQuizAutomation('<html><body></body></html>');
    const jumps = [];
    const marked = [];
    try {
        app._markSectionCompleted = () => marked.push(true);
        app._computeNextNode = () => ({ c: 0, n: 1 });
        app._jumpToSection = (c, n) => {
            jumps.push([c, n]);
            return true;
        };
        await app.nextUnit();
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.ok(marked.length >= 1, '前进前应把当前小节记为已完成');
        assert.deepEqual(jumps, [[0, 1]], '没有「下一节」按钮时应按目录跳转');
    } finally {
        restore();
    }
});

