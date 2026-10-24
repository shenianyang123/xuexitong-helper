/* 章节测验自动答题（DeepSeek）
 * 由 scripts/build.mjs 内联进 deepseek-console/xuexitong-console.js。
 * 依赖 app 的公开/半公开 API：_nextUnitPending / _clearCheckInterval / _videoEl / _isPlaying /
 * _initCellData / _currentStepTitle / _getVideoEl / play / _markSectionCompleted。
 */

function attachQuizAutomation(app) {
const attemptedQuizzes = new Set();
let quizBusy = false;
let stopped = false;
const originalDestroy = app.destroy.bind(app);
app.destroy = function () {
stopped = true;
originalDestroy();
};

const note = (text, level) => { if (typeof app._note === 'function') app._note(text, level); };
const setStatus = (text) => { if (typeof app._setStatus === 'function') app._setStatus(text); };
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const visible = (el) => Boolean(el && el.isConnected && el.getClientRects().length &&
el.ownerDocument.defaultView.getComputedStyle(el).visibility !== 'hidden');
const kindPattern = /[\[【](单选题|多选题|判断题)[\]】]/;

function courseDocuments() {
const result = [];
const visit = (doc, depth) => {
if (!doc || depth > 3 || result.includes(doc)) return;
result.push(doc);
for (const frame of doc.querySelectorAll('iframe')) {
try { visit(frame.contentDocument, depth + 1); } catch (_) { /* cross origin */ }
}
};
visit(document, 0);
return result;
}

/* 判据要宽松：真实成绩页文案是「本次成绩：100」「得分：100.0 分」（中间有全角冒号），
 * 旧正则 /本次成绩\s*\d+…分/ 永远匹配不到，导致提交后一直等待、面板卡死。 */
const SCORE_PATTERNS = [
/本次成绩\s*[:：]?\s*\d+(?:\.\d+)?/,
/得分\s*[:：]?\s*\d+(?:\.\d+)?/,
/成绩\s*[:：]\s*\d+(?:\.\d+)?/,
];
const SCORE_SELECTOR = '.Tis_Score,.mark_score,.markScore,#mark_score,.result-score,.score-num';

function quizCompleted() {
const scoreShown = courseDocuments().some((doc) => {
let text = '';
try { text = clean(doc.body?.innerText); } catch (_) { text = ''; }
if (SCORE_PATTERNS.some((pattern) => pattern.test(text))) return true;
try { if (doc.querySelector(SCORE_SELECTOR)) return true; } catch (_) { /* ignore */ }
const hasGrade = /成绩|得分/.test(text);
return hasGrade && (/章节测验\s*已完成/.test(text) || /我的答案\s*[:：]/.test(text) || /查看答案/.test(text));
});
if (scoreShown) return true;
const cardsFrame = Array.from(document.querySelectorAll('iframe[src*="/knowledge/cards"]'))
.find((frame) => frame.getClientRects().length > 0);
const isQuizStep = cardsFrame && new URL(cardsFrame.getAttribute('src'), location.href).searchParams.get('num') === '1';
return Boolean(isQuizStep && document.querySelector('.posCatalog_active .icon_Completed'));
}

function optionElements(card) {
const labels = Array.from(card.querySelectorAll('span,div,label,li,p,b,i,strong,a'))
.filter((el) => /^[A-H]$/.test(clean(el.textContent)) &&
!Array.from(el.children).some((child) => /^[A-H]$/.test(clean(child.textContent))));
const found = new Map();
for (const label of labels) {
const letter = clean(label.textContent);
if (found.has(letter)) continue;
let target = label;
for (let n = 0; n < 5; n++) {
const parent = target.parentElement;
if (!parent || parent === card) break;
const otherLetters = Array.from(parent.querySelectorAll('span,div,label,li,p,b,i,strong,a'))
.filter((el) => /^[A-H]$/.test(clean(el.textContent)) && el !== label);
if (otherLetters.some((el) => !el.contains(label) && !label.contains(el))) break;
target = parent;
if (clean(target.innerText).length > 1) break;
}
const text = clean(target.innerText).replace(new RegExp(`^${letter}[.、．]?\\s*`), '');
if (text) found.set(letter, { letter, text, element: target });
}
return Array.from(found.values()).sort((a, b) => a.letter.localeCompare(b.letter));
}

/* 新版页面（mooc-ans）的选项没有 A/B 字母，例如判断题直接是「对 / 错」。
 * 这类题用 input[type=radio|checkbox] 的 name 分组定位，按 DOM 顺序映射成 A/B/C…，
 * 再把选项文案交给 DeepSeek，回答的字母再映射回同一个 input。 */
function inputOptionElements(card, inputs) {
const found = [];
for (const input of inputs) {
const label = input.closest('label') || input.parentElement;
const text = clean((label && label.innerText) || input.getAttribute('aria-label') ||
input.getAttribute('value') || input.title || '');
if (!text) continue;
found.push({ letter: String.fromCharCode(65 + found.length), text, element: label || input, input });
if (found.length >= 8) break;
}
return found;
}

function extractQuestionsByInputs() {
const questions = [];
const seen = new Set();
for (const doc of courseDocuments()) {
const inputs = Array.from(doc.querySelectorAll('input[type="radio"],input[type="checkbox"]'))
.filter((el) => visible(el) || (el.closest('label') && visible(el.closest('label'))));
if (!inputs.length) continue;
const groups = new Map();
for (const input of inputs) {
const name = input.name || '__xxt_noname__';
if (!groups.has(name)) groups.set(name, []);
groups.get(name).push(input);
}
for (const group of groups.values()) {
if (group.length < 2 || group.length > 8) continue;
let container = group[0].parentElement;
while (container && container !== doc.body) {
const text = clean(container.innerText);
const insideAll = group.every((input) => container.contains(input));
if (insideAll && kindPattern.test(text) && text.length > 6) break;
container = container.parentElement;
}
if (!container || container === doc.body || seen.has(container)) continue;
const text = clean(container.innerText);
const kinds = text.match(new RegExp(kindPattern.source, 'g')) || [];
if (kinds.length !== 1) continue;
const options = inputOptionElements(container, group);
if (options.length < 2) continue;
seen.add(container);
let title = text;
for (const option of options) {
const at = title.indexOf(option.text);
if (at > 0) { title = title.slice(0, at); break; }
}
title = clean(title).replace(/^\d+\s*/, '').replace(kindPattern, '').trim();
if (!title || title.length > 500) continue;
questions.push({ kind: kinds[0].match(kindPattern)[1], title, options, card: container, doc });
}
}
return questions;
}

function extractQuestionsByLetters() {
const questions = [];
for (const doc of courseDocuments()) {
const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
const seenCards = new Set();
let node;
while ((node = walker.nextNode())) {
const kind = clean(node.textContent).match(kindPattern)?.[1];
if (!kind || !visible(node.parentElement)) continue;
let card = node.parentElement;
let options = [];
for (let depth = 0; card && depth < 9; depth++, card = card.parentElement) {
const cardText = clean(card.innerText);
const kinds = cardText.match(new RegExp(kindPattern.source, 'g')) || [];
if (kinds.length > 1) break;
options = optionElements(card);
if (options.length >= 2 && options.length <= 8) break;
}
if (!card || options.length < 2 || options.length > 8 || seenCards.has(card)) continue;
seenCards.add(card);
const full = card.innerText || '';
const firstOption = full.search(/(?:^|\n)\s*A\s*(?:[.、．]|\S)/);
const title = clean(firstOption >= 0 ? full.slice(0, firstOption) :
(node.parentElement.innerText || full))
.replace(/^\d+\s*/, '').replace(kindPattern, '').trim();
if (!title || title.length > 500 || options.some((option) => !option.text || option.text.length > 500)) continue;
questions.push({ kind, title, options, card, doc });
}
}
return questions;
}

function extractQuestions() {
const lettered = extractQuestionsByLetters();
if (lettered.length) return lettered;
return extractQuestionsByInputs();
}

function findButton(doc, label) {
const candidates = Array.from(doc.querySelectorAll('button,a,input[type="button"],input[type="submit"],[role="button"],div,span'))
.filter((el) => visible(el) && clean(el.value || el.innerText) === label);
return candidates.find((el) => /^(BUTTON|A|INPUT)$/.test(el.tagName)) ||
candidates.find((el) => !Array.from(el.children).some((child) => clean(child.innerText) === label)) || null;
}

function findNextButton() {
for (const doc of courseDocuments()) {
const known = doc.querySelector('#prevNextFocusNext, #right1, .nextChapter');
if (visible(known) && clean(known.innerText || known.title).includes('下一节')) return known;
const generic = findButton(doc, '下一节');
if (generic) return generic;
}
return null;
}

async function revealQuizQuestions() {
const docs = courseDocuments();
const submit = docs.map((doc) => findButton(doc, '提交')).find(Boolean);
if (!submit) return;
let scroller = submit.parentElement;
while (scroller && scroller !== submit.ownerDocument.body) {
const style = scroller.ownerDocument.defaultView.getComputedStyle(scroller);
if (/(auto|scroll)/.test(style.overflowY) && scroller.scrollHeight > scroller.clientHeight + 100) break;
scroller = scroller.parentElement;
}
if (!scroller || scroller === submit.ownerDocument.body) {
scroller = submit.ownerDocument.scrollingElement;
}
if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 100) return;
scroller.scrollTop = 0;
await sleep(150);
for (let step = 0; step < 50; step++) {
const bottom = scroller.scrollHeight - scroller.clientHeight;
if (scroller.scrollTop >= bottom - 2) break;
scroller.scrollTop = Math.min(bottom, scroller.scrollTop + Math.max(300, scroller.clientHeight * 0.75));
await sleep(120);
}
}

async function waitForQuizQuestions() {
let submitDoc = null;
for (let attempt = 0; attempt < 240; attempt++) {
if (stopped) throw new Error('脚本已停止');
if (quizCompleted()) return null;
submitDoc = courseDocuments().find((doc) => findButton(doc, '提交'));
if (submitDoc) break;
if (attempt > 0 && attempt % 30 === 0) {
console.log(`测验提交按钮仍在加载，已等待 ${attempt / 2} 秒`);
note(`等待测验页面加载…已 ${attempt / 2} 秒`, 'info');
}
await sleep(500);
}
if (!submitDoc) throw new Error('进入章节测验后等待 120 秒，仍未找到“提交”按钮。请检查题目框架是否正常加载');

await revealQuizQuestions();
let previousSignature = '';
let stableCount = 0;
for (let attempt = 0; attempt < 240; attempt++) {
if (stopped) throw new Error('脚本已停止');
if (quizCompleted()) return null;
const questions = extractQuestions();
const countText = clean(submitDoc.body.innerText).match(/题量\s*[:：]\s*(\d+)/);
const expected = countText ? Number(countText[1]) : null;
if (questions.length && (!expected || questions.length === expected)) {
const signature = questions.map((q) => `${q.kind}:${q.title}:${q.options.length}`).join('|');
stableCount = signature === previousSignature ? stableCount + 1 : 0;
previousSignature = signature;
if (stableCount >= 3) return questions;
} else {
stableCount = 0;
previousSignature = '';
}
if (attempt > 0 && attempt % 20 === 0) {
console.log(`测验题目仍在加载，已等待 ${attempt / 2} 秒；当前识别 ${questions.length} 道`);
note(`正在识别测验题目…已 ${attempt / 2} 秒，识别到 ${questions.length} 道` +
(expected ? `（页面显示 ${expected} 道）` : ''), 'info');
}
await sleep(500);
}
throw new Error('测验框架已打开，但等待 120 秒仍未识别完整题目。可运行 app.inspectQuiz() 查看当前识别结果');
}

async function askDeepSeek(questions) {
const payload = questions.map((q, i) => ({
id: i + 1,
type: q.kind,
question: q.title,
options: q.options.map((o) => ({ letter: o.letter, text: o.text })),
}));
console.log('以下是本次发送给 DeepSeek 的题干和选项：', payload);
let response;
try {
response = await fetch(`${LOCAL_URL}/answer`, {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'X-Xuexitong-Token': LOCAL_TOKEN },
body: JSON.stringify({ questions: payload }),
signal: AbortSignal.timeout(900000),
});
} catch (error) {
throw new Error(`无法连接本地 DeepSeek 服务。请确认启动窗口仍在运行，且 Edge 允许本地网络访问。详情：${error.message}`);
}
const data = await response.json().catch(() => null);
if (!response.ok) throw new Error(data?.error || `本地 DeepSeek 服务返回 HTTP ${response.status}`);
return data.answers;
}

function validateAnswers(questions, answers) {
if (!Array.isArray(answers) || answers.length !== questions.length) throw new Error('AI 返回的题目数量不匹配');
const result = new Map();
for (const item of answers) {
if (!Number.isInteger(item.id) || result.has(item.id) || !Array.isArray(item.letters))
throw new Error('AI 答案格式错误');
const q = questions[item.id - 1];
if (!q) throw new Error('AI 返回未知题号');
const letters = item.letters.map((letter) => clean(letter).toUpperCase());
if (!letters.length) throw new Error(`第 ${item.id} 题 AI 未给出选项，已停止提交`);
if (new Set(letters).size !== letters.length) throw new Error(`第 ${item.id} 题答案包含重复选项，已停止提交`);
if (q.kind !== '多选题' && letters.length !== 1)
throw new Error(`第 ${item.id} 题是${q.kind}，但 AI 返回了 ${letters.length} 个选项，已停止提交`);
const invalidLetters = letters.filter((letter) => !q.options.some((option) => option.letter === letter));
if (invalidLetters.length)
throw new Error(`第 ${item.id} 题 AI 返回了页面中不存在的选项：${invalidLetters.join('、')}，已停止提交`);
result.set(item.id, letters);
}
return result;
}

function optionInput(option) {
const el = option?.element;
if (!el) return null;
if (el.matches && el.matches('input')) return el;
return el.querySelector ? el.querySelector('input') : null;
}

/* radio/checkbox 的选中态是 property，不会出现在 outerHTML 里，所以必须直接读 checked；
 * 新版 mooc-ans 的选项是 label 包 input，点击外层 li/label 有时不落到热区，只能直接点 input。 */
function optionSelected(option) {
const input = optionInput(option);
if (input && input.checked) return true;
let node = option.element;
for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
if (typeof node.getAttribute === 'function') {
const aria = node.getAttribute('aria-checked') || node.getAttribute('aria-selected');
if (aria === 'true') return true;
}
const cls = typeof node.className === 'string' ? node.className : '';
if (/(^|[\s_-])(checked|active|selected)([\s_-]|$)/.test(cls)) return true;
}
return false;
}

function pressOptionTarget(el) {
if (!el) return;
try {
el.scrollIntoView({ block: 'center' });
} catch (_) {}
const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
for (const type of ['mousedown', 'mouseup']) {
try {
el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, view: win }));
} catch (_) {}
}
try {
el.click();
} catch (_) {}
}

async function selectAnswers(questions, answers) {
for (let i = 0; i < questions.length; i++) {
const q = questions[i];
for (const letter of answers.get(i + 1)) {
if (stopped) throw new Error('脚本已停止');
const option = q.options.find((item) => item.letter === letter);
if (!option?.element?.isConnected) throw new Error(`第 ${i + 1} 题选项已变化`);
const snapshot = () => (q.card ? q.card.outerHTML : '');
const before = snapshot();
const input = optionInput(option);
const targets = [];
if (input) targets.push(input);
targets.push(option.element);
if (option.element.parentElement) targets.push(option.element.parentElement);
const label = option.element.closest ? option.element.closest('label') : null;
if (label && !targets.includes(label)) targets.push(label);
for (const target of targets) {
if (optionSelected(option) || snapshot() !== before) break;
pressOptionTarget(target);
await sleep(140);
}
if (!optionSelected(option) && snapshot() === before && input) {
try {
input.checked = true;
const win = (input.ownerDocument && input.ownerDocument.defaultView) || window;
input.dispatchEvent(new win.Event('input', { bubbles: true }));
input.dispatchEvent(new win.Event('change', { bubbles: true }));
input.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, view: win }));
} catch (_) {}
await sleep(120);
}
if (!optionSelected(option) && snapshot() === before)
throw new Error(`第 ${i + 1} 题 ${letter} 选项未确认选中，已停止提交`);
}
}
}

async function confirmSubmitDialog() {
for (let i = 0; i < 20; i++) {
if (stopped) throw new Error('脚本已停止');
const dialogs = courseDocuments().flatMap((doc) =>
Array.from(doc.querySelectorAll('#popok,[role="dialog"],[role="alertdialog"],.layui-layer-dialog,.el-message-box,.modal')));
const platformButton = dialogs.find((el) => el.id === 'popok' && visible(el));
if (platformButton) {
const message = clean(platformButton.ownerDocument.querySelector('#popcontent')?.innerText);
if (/未作答|请选择|请作答|答完/.test(message) && !/确定提交|确认提交/.test(message))
throw new Error(`平台拒绝提交：${message}`);
console.log(`确认平台提交窗口：${message || '提交'}`);
platformButton.click();
return;
}
const dialog = dialogs.find((el) => el.id !== 'popok' && visible(el) && /提交|交卷/.test(clean(el.innerText)));
if (dialog) {
const confirm = findButton(dialog, '确定') || findButton(dialog, '确认') || findButton(dialog, '提交');
if (!confirm) throw new Error('提交确认窗口未找到确认按钮');
confirm.click();
return;
}
await sleep(250);
}
}

async function submitQuiz(doc) {
if (stopped) throw new Error('脚本已停止');
const submit = findButton(doc, '提交');
if (!submit) throw new Error('未找到测验提交按钮');
submit.scrollIntoView({ block: 'center' });
console.log('选项已选择，点击章节测验的提交按钮');
submit.click();
await confirmSubmitDialog();
console.log('提交已确认，等待学习通生成成绩或任务完成标记；确认后再点击“下一节”');
note('已点击提交，等待平台生成成绩…', 'info');
let elapsedHalfSeconds = 0;
/* 45 秒还没出现成绩页就不要静默空转：只要“提交”按钮已消失就按已提交继续，
 * 否则抛错让面板显示“需手动处理”，避免用户看到面板永远卡在“章节测验自动作答中”。 */
const deadlineHalfSeconds = 90;
while (!stopped) {
await sleep(500);
elapsedHalfSeconds++;
if (quizCompleted()) return;
if (elapsedHalfSeconds % 10 === 0)
note(`已提交，等待平台生成成绩…已 ${elapsedHalfSeconds / 2} 秒`, 'info');
if (elapsedHalfSeconds % 30 === 0)
console.log(`成绩页仍在加载，已等待 ${elapsedHalfSeconds / 2} 秒`);
if (elapsedHalfSeconds >= deadlineHalfSeconds) {
if (!findButton(doc, '提交')) {
note('提交按钮已消失，按“已提交”继续下一节', 'warn');
return;
}
throw new Error('提交后 45 秒仍未出现成绩页，请手动确认测验是否提交成功');
}
}
throw new Error('脚本已停止');
}

async function goToNextStep() {
if (stopped) throw new Error('脚本已停止');
if (typeof app._markSectionCompleted === 'function') app._markSectionCompleted();
const next = findNextButton();
if (!next) {
/* 成绩页/部分新版页面底部没有“下一节”按钮：改按课程目录直接跳到下一小节 */
const target = typeof app._computeNextNode === 'function' ? app._computeNextNode() : null;
if (!target || typeof app._jumpToSection !== 'function')
throw new Error('未找到页面下方的“下一节”按钮，也未取到下一小节');
note(`未找到“下一节”按钮，按目录跳到第 ${target.c + 1} 章第 ${target.n + 1} 节`, 'info');
app._nextUnitPending = false;
if (!app._jumpToSection(target.c, target.n))
throw new Error('按目录跳转下一小节失败');
return;
}
app._nextUnitPending = true;
const previousStep = app._currentStepTitle();
app._clearCheckInterval();
app._videoEl = null;
app._isPlaying = false;
next.scrollIntoView({ block: 'center' });
console.log(`${previousStep || '当前学习步骤'}完成，点击页面“下一节”，等待新内容加载`);
next.click();
let currentStep = '';
let stepReady = false;
for (let attempt = 0; attempt < 240; attempt++) {
if (stopped) throw new Error('脚本已停止');
await sleep(500);
currentStep = app._currentStepTitle();
if (currentStep !== previousStep && currentStep === '章节测验') {
stepReady = true;
break;
}
if (currentStep !== previousStep && currentStep === '视频') {
app._videoEl = null;
if (app._getVideoEl()) {
stepReady = true;
break;
}
}
if (attempt > 0 && attempt % 30 === 0) console.log(`下一学习步骤仍在加载，已等待 ${attempt / 2} 秒；当前页签：${currentStep || '未显示'}`);
}
if (!stepReady) {
throw new Error(`点击“下一节”后等待 120 秒，新学习步骤仍未加载完成；当前页签：${currentStep || '未显示'}`);
}
app._nextUnitPending = false;
app._videoEl = null;
app._initCellData();
app.play();
}

app.nextUnit = function () {
if (stopped || this._nextUnitPending) return;
this._nextUnitPending = true;
if (typeof app._markSectionCompleted === 'function') app._markSectionCompleted();
goToNextStep().catch((error) => {
this._nextUnitPending = false;
console.error('切换下一学习步骤失败:', error);
});
};

app.inspectQuiz = function () {
return extractQuestions().map((q, i) => ({
id: i + 1, type: q.kind, question: q.title,
options: q.options.map((o) => `${o.letter}. ${o.text}`),
}));
};

/* 便于离线排查：在控制台执行 app.inspectQuizDetail() 查看识别来源 */
app.inspectQuizDetail = function () {
const letters = extractQuestionsByLetters();
const byInputs = extractQuestionsByInputs();
return {
byLetters: letters.length,
byInputs: byInputs.length,
radios: courseDocuments().map((doc) => doc.querySelectorAll('input[type="radio"],input[type="checkbox"]').length),
questions: (letters.length ? letters : byInputs).map((q, i) => ({
id: i + 1, type: q.kind, question: q.title,
options: q.options.map((o) => `${o.letter}. ${o.text}`),
})),
};
};

app._quizExtract = {
all: extractQuestions,
byLetters: extractQuestionsByLetters,
byInputs: extractQuestionsByInputs,
letterOptions: optionElements,
select: selectAnswers,
completed: quizCompleted,
};

app._advanceChapterTest = function () {
if (stopped || quizBusy) return;
quizBusy = true;
setStatus('章节测验自动作答中');
note('检测到章节测验，开始自动作答', 'warn');
(async () => {
if (quizCompleted()) {
console.log('检测到当前章节测验已完成，点击“下一节”进入新视频');
note('章节测验已完成，进入下一节', 'ok');
await goToNextStep();
return;
}
console.log('已进入章节测验，等待题目和提交按钮加载');
const questions = await waitForQuizQuestions();
if (questions === null) {
console.log('检测到当前章节测验已完成，点击“下一节”进入新视频');
note('章节测验已完成，进入下一节', 'ok');
await goToNextStep();
return;
}
if (questions.length > 30) throw new Error('题目数量超过 30，已停止自动提交');
const docs = new Set(questions.map((q) => q.doc));
if (docs.size !== 1) throw new Error('题目跨多个框架，已停止自动提交');
const countText = clean(questions[0].doc.body.innerText).match(/题量\s*[:：]\s*(\d+)/);
if (countText && Number(countText[1]) !== questions.length)
throw new Error(`页面显示 ${countText[1]} 道题，脚本只识别 ${questions.length} 道，已停止提交`);
const signature = questions.map((q) => `${q.kind}:${q.title}`).join('|');
if (attemptedQuizzes.has(signature)) throw new Error('本次测验已尝试过，已停止重复提交');
console.log(`识别到 ${questions.length} 道题，正在调用 DeepSeek`);
note(`已识别 ${questions.length} 道题，正在请求 DeepSeek…`, 'info');
const answers = validateAnswers(questions, await askDeepSeek(questions));
console.table(questions.map((q, i) => ({ 题号: i + 1, 题型: q.kind, 选择: answers.get(i + 1).join('') })));
note('DeepSeek 已给出答案，正在勾选选项', 'info');
await selectAnswers(questions, answers);
attemptedQuizzes.add(signature);
note('选项已勾选，正在提交测验', 'info');
await submitQuiz(questions[0].doc);
console.log('章节测验提交已确认，点击“下一节”进入新视频');
note('章节测验已提交，进入下一节', 'ok');
quizBusy = false;
await goToNextStep();
})().catch((error) => {
app._nextUnitPending = false;
setStatus('章节测验需手动处理');
note('章节测验自动作答停止：' + (error && error.message ? error.message : error), 'error');
console.error('章节测验自动作答停止:', error);
})
.finally(() => { quizBusy = false; });
};

}
