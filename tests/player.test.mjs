import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, 'v3_optimized.js'), 'utf8');

const SETTINGS_KEY = 'xuexitong.helper.settings.v1';
const PROGRESS_KEY = 'xuexitong.helper.progress.v1';
const POSITIONS_KEY = 'xuexitong.helper.positions.v1';

const PAGE_HTML = `<!doctype html>
<html><head><title>学习通</title></head>
<body>
  <div class="prev_title">1.1 视频一</div>
  <div class="prev_white">1.1 视频</div>
  <div class="prev_white">1.2 视频</div>
  <div id="coursetree">
    <ul>
      <li>
        <div class="posCatalog_select firstLayer"><span class="posCatalog_name">第一章</span></div>
        <ul>
          <li><div class="posCatalog_select posCatalog_active"><span class="posCatalog_name" title="1.1 视频一">1.1 视频一</span></div></li>
          <li><div class="posCatalog_select"><span class="posCatalog_name" title="1.2 视频二">1.2 视频二</span></div></li>
        </ul>
      </li>
      <li>
        <div class="posCatalog_select firstLayer"><span class="posCatalog_name">第二章</span></div>
        <ul>
          <li><div class="posCatalog_select"><span class="posCatalog_name" title="2.1 视频三">2.1 视频三</span></div></li>
        </ul>
      </li>
    </ul>
  </div>
  <video id="video_html5_api"></video>
</body></html>`;

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** 新版 mooc-ans 学生页：目录里没有 #coursetree，只有调用 getTeacherAjax 的小节链接。 */
const LINK_PAGE_HTML = `<!doctype html>
<html><head><title>学习通</title></head>
<body>
  <div class="prev_title">1.1 何为心理健康</div>
  <div class="prev_white">1.1 何为心理健康</div>
  <div class="prev_white">1.2 心理健康的标准</div>
  <div class="prev_white">2.1 认识自我</div>
  <ul>
    <li><span class="catalog_num">1</span><a href="javascript:getTeacherAjax('268192668','157461710','1266657450')">1.1 何为心理健康</a></li>
    <li><span class="catalog_num">1.2</span><a href="javascript:getTeacherAjax('268192668','157461710','1266657451')">1.2 心理健康的标准</a></li>
    <li><span class="catalog_num">2</span><a href="javascript:getTeacherAjax('268192668','157461710','1266657460')">2.1 认识自我</a></li>
  </ul>
  <video id="video_html5_api"></video>
</body></html>`;

/** 创建一个尽量接近真实学习通播放页的 jsdom 环境，并加载 V3 产物。 */
function createPage(options = {}) {
    const dom = new JSDOM(options.html || PAGE_HTML, {
        url: options.url || 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=100&clazzid=1',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;

    // 让可见性判断可用（jsdom 没有排版，getClientRects 永远返回空）
    window.Element.prototype.getClientRects = function getClientRects() {
        if (!this.isConnected) return [];
        if (this.style && (this.style.display === 'none' || this.style.visibility === 'hidden')) return [];
        const rect = { x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 };
        return Object.assign([rect], { item: (index) => (index === 0 ? rect : null) });
    };

    // 模拟媒体元素行为
    window.HTMLMediaElement.prototype.play = function play() {
        this._playing = true;
        this.dispatchEvent(new window.Event('play'));
        this.dispatchEvent(new window.Event('playing'));
        return Promise.resolve();
    };
    window.HTMLMediaElement.prototype.pause = function pause() {
        this._playing = false;
        this.dispatchEvent(new window.Event('pause'));
    };
    window.HTMLMediaElement.prototype.load = function load() {};

    window.eval(SOURCE);
    return { dom, window, app: window.app };
}

/** 给 media 元素造出可用的时长/进度，并触发 loadedmetadata。 */
function fakeVideo(video, window, duration = 100) {
    let currentTime = 0;
    Object.defineProperty(video, 'duration', { configurable: true, get: () => duration });
    Object.defineProperty(video, 'currentTime', {
        configurable: true,
        get: () => currentTime,
        set: (value) => { currentTime = Number(value) || 0; },
    });
    Object.defineProperty(video, 'readyState', { configurable: true, get: () => 4 });
    video.dispatchEvent(new window.Event('loadedmetadata'));
    return video;
}

test('V3 入口能在课程页启动并暴露 window.app', () => {
    const { dom, window, app } = createPage();
    try {
        assert.ok(app, 'window.app 应存在');
        assert.equal(window.__xuexitongPlayerV3, app);
        assert.equal(app._destroyed, false);
        assert.equal(app.configs.playbackRate, 1.5);
    } finally {
        window.app?.destroy();
        dom.window.close();
    }
});

test('悬浮球：默认只显示球，点开是功能菜单，可收起并持久化', () => {
    const { dom, window, app } = createPage();
    try {
        const host = window.document.getElementById('xuexitong-helper-hud');
        assert.ok(host, '悬浮球宿主节点应挂载到 body');
        const root = host.shadowRoot;
        assert.ok(root, '悬浮球应使用 Shadow DOM 隔离样式');

        const ball = root.querySelector('.xxt-ball');
        const panel = root.querySelector('.xxt-panel');
        assert.ok(ball, '应渲染悬浮球');
        assert.equal(panel.getAttribute('data-open'), '0', '默认只显示悬浮球');
        assert.equal(app.configs.hudCollapsed, true);

        ball.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        assert.equal(panel.getAttribute('data-open'), '1', '点击球应展开菜单');
        assert.equal(app.configs.hudCollapsed, false);
        assert.ok(root.querySelector('.xxt-badge'), '球上应有进度角标');

        assert.match(root.querySelector('.xxt-title').textContent, /学习通/);
        assert.ok(root.querySelectorAll('.xxt-select option').length >= 4, '应提供倍速选项');

        const pills = root.querySelectorAll('.xxt-pill');
        assert.equal(pills.length, 4, '菜单里应提供 4 个开关');
        const mutePill = Array.from(pills).find((pill) => pill.getAttribute('data-setting') === 'muteVideo');
        const before = app.configs.muteVideo;
        mutePill.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        assert.notEqual(app.configs.muteVideo, before, '点击开关应切换设置');
        assert.equal(mutePill.classList.contains('is-on'), app.configs.muteVideo);

        root.querySelector('.xxt-fold').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        assert.equal(panel.getAttribute('data-open'), '0', '点 × 应收起为球');
        assert.equal(app.configs.hudCollapsed, true);
    } finally {
        window.app?.destroy();
        dom.window.close();
    }
});

test('控制台可用 app.showHud() 展开/收起悬浮球菜单', () => {
    const { dom, window, app } = createPage();
    try {
        const root = window.document.getElementById('xuexitong-helper-hud').shadowRoot;
        const panel = root.querySelector('.xxt-panel');
        assert.equal(panel.getAttribute('data-open'), '0');
        app.showHud();
        assert.equal(panel.getAttribute('data-open'), '1');
        app.showHud();
        assert.equal(panel.getAttribute('data-open'), '0');
        app.showHud(true);
        assert.equal(panel.getAttribute('data-open'), '1');
        app.hideHud();
        assert.equal(panel.getAttribute('data-open'), '0');
    } finally {
        window.app?.destroy();
        dom.window.close();
    }
});

test('课程目录解析：当前小节与下一节计算正确', () => {
    const { dom, window, app } = createPage();
    try {
        const data = app.cellData;
        assert.equal(data.cells.length, 2, '应识别 2 个一级章节');
        assert.equal(data.currentCellIndex, 0);
        assert.equal(data.nCells.length, 2, '第一章应有 2 个小节');
        assert.equal(data.currentNCellIndex, 0);
        assert.equal(data.currentVideoTitle, '1.1 视频一');
        const next = app._computeNextNode();
        assert.deepEqual({ ...next }, { c: 0, n: 1 });
    } finally {
        window.app?.destroy();
        dom.window.close();
    }
});

test('设置写入即持久化到 localStorage', async () => {
    const { dom, window, app } = createPage();
    try {
        app.configs.autoplay = false;
        app.configs.playbackRate = 2;
        // 防抖写盘
        await wait(350);

        const saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || '{}');
        assert.equal(saved.autoplay, false);
        assert.equal(saved.playbackRate, 2);

        app.updateSettings({ muteVideo: true });
        await wait(350);
        assert.equal(JSON.parse(window.localStorage.getItem(SETTINGS_KEY)).muteVideo, true);
    } finally {
        window.app?.destroy();
        dom.window.close();
    }
});

test('进度记录与断点续播目标可写入、可重置', () => {
    const { dom, window, app } = createPage();
    try {
        app._markSectionCompleted();
        const progress = app.progress();
        assert.equal(progress.completed, 1);
        assert.ok(
            progress.sections.some((item) => item.key === '0|0' && item.title === '1.1 视频一'),
            '当前小节应记录为已完成'
        );
        assert.deepEqual({ ...progress.resumeTarget }, { c: 0, n: 1, title: '1.2 视频二' });

        const stored = JSON.parse(window.localStorage.getItem(PROGRESS_KEY) || '{}');
        assert.ok(stored.sections['0|0']);
        assert.deepEqual(stored.resumeTarget, { c: 0, n: 1, title: '1.2 视频二' });

        app.resetProgress();
        assert.equal(app.progress().completed, 0);
        assert.equal(window.localStorage.getItem(PROGRESS_KEY), null);
        assert.equal(window.localStorage.getItem(POSITIONS_KEY), null);
    } finally {
        window.app?.destroy();
        dom.window.close();
    }
});

test('视频位置会被记录，用于小节内续播', () => {
    const { dom, window, app } = createPage();
    try {
        const video = window.document.querySelector('#video_html5_api');
        fakeVideo(video, window, 300);
        app._videoEl = video;
        video.currentTime = 42;
        app._savePosition(video, true);

        const stored = JSON.parse(window.localStorage.getItem(POSITIONS_KEY) || '{}');
        assert.equal(stored['0|0#0'].t, 42);
        assert.equal(stored['0|0#0'].d, 300);
    } finally {
        window.app?.destroy();
        dom.window.close();
    }
});

test('多视频小节：能找到主文档与 iframe 内的视频', () => {
    const { dom, window, app } = createPage();
    try {
        const iframe = window.document.createElement('iframe');
        iframe.className = 'ans-insertvideo-online';
        window.document.body.appendChild(iframe);
        const inner = iframe.contentDocument.createElement('video');
        inner.id = 'video_html5_api';
        iframe.contentDocument.body.appendChild(inner);

        const videos = app._collectVideos(true);
        assert.equal(videos.length, 2, '主文档 1 个 + iframe 内 1 个');
        videos.forEach((video) => assert.notEqual(video.tagName, 'IFRAME'));
    } finally {
        window.app?.destroy();
        dom.window.close();
    }
});

test('页面守卫不再拦截鼠标事件（回归：旧版会 preventDefault）', () => {
    const { dom, window, app } = createPage();
    try {
        const mouseout = new window.MouseEvent('mouseout', { bubbles: true, cancelable: true });
        window.document.dispatchEvent(mouseout);
        assert.equal(mouseout.defaultPrevented, false, 'mouseout 不应被 preventDefault');

        const mouseleave = new window.MouseEvent('mouseleave', { bubbles: true, cancelable: true });
        window.document.dispatchEvent(mouseleave);
        assert.equal(mouseleave.defaultPrevented, false, 'mouseleave 不应被 preventDefault');
    } finally {
        window.app?.destroy();
        dom.window.close();
    }
});

test('destroy 会停止定时器并移除 HUD；重复注入会替换旧实例', () => {
    const { dom, window, app } = createPage();
    try {
        const first = window.app;
        assert.ok(window.document.getElementById('xuexitong-helper-hud'));

        window.eval(SOURCE);
        const second = window.app;
        assert.notEqual(second, first, '应创建新实例');
        assert.equal(first._destroyed, true, '旧实例应被销毁');
        assert.equal(window.document.querySelectorAll('#xuexitong-helper-hud').length, 1, 'HUD 不应重复');

        second.destroy();
        assert.equal(window.document.getElementById('xuexitong-helper-hud'), null);
    } finally {
        dom.window.close();
    }
});

test('倍速锁定：播放器把倍速改回 1 倍时会被拦截（学习通新版会强制改回 1x）', () => {
    const { dom, window, app } = createPage();
    try {
        const video = window.document.getElementById('video_html5_api');
        app._lockPlaybackRate(video, 2);
        assert.equal(video.playbackRate, 2, '锁定后应为 2 倍速');

        // 模拟学习通播放器强行改写倍速
        video.playbackRate = 1;
        assert.equal(video.playbackRate, 2, '外部改回 1 倍速应被忽略');
        assert.equal(video.__xxtRateLock.blocked, 1, '应记录一次被拦截的改写');

        // 用户在 HUD 里改成 3 倍速要能真正生效
        app.updateSettings({ playbackRate: 3 });
        assert.equal(video.playbackRate, 3);
        assert.equal(app.configs.playbackRate, 3);
    } finally {
        window.app?.destroy();
        dom.window.close();
    }
});

test('诊断信息会写入 localStorage，便于站点改版后离线排查', () => {
    const { dom, window, app } = createPage();
    try {
        app._writeDiagnostics('test');
        const raw = window.localStorage.getItem('xuexitong.helper.diag.v1');
        assert.ok(raw, '应写入诊断键 xuexitong.helper.diag.v1');
        const diag = JSON.parse(raw);
        assert.equal(diag.reason, 'test');
        assert.match(String(diag.version), /^\d+\.\d+\.\d+$/, '诊断里应带脚本版本号');
        assert.equal(diag.dom.treeFound, true, '诊断应记录目录是否找到');
        assert.equal(diag.dom.counts['#coursetree'], 1);
        assert.ok(Array.isArray(diag.frames));
        assert.ok(Array.isArray(diag.dom.outline) && diag.dom.outline.length > 0);
        assert.equal(diag.cells.chapters, 2);
    } finally {
        window.app?.destroy();
        dom.window.close();
    }
});

test('URL 参数 xxtrate 可指定倍速（站点强制改回 1x 时的兜底手段）', () => {
    const { dom, window, app } = createPage({
        url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=100&clazzid=1&xxtrate=2',
    });
    try {
        assert.equal(app.configs.playbackRate, 2, 'xxtrate=2 应把倍速设为 2');
    } finally {
        window.app?.destroy();
        dom.window.close();
    }
});

test('目录容器没有 #coursetree 时也能回退解析（站点改版兜底）', () => {
    const { dom, window, app } = createPage();
    try {
        const tree = window.document.getElementById('coursetree');
        assert.ok(tree, '测试页面应带 #coursetree');
        tree.removeAttribute('id');
        assert.ok(app._getTreeContainer(), '没有 #coursetree 时应能回退找到目录容器');
        app._initCellData();
        assert.equal(app.cellData.cells.length, 2, '回退后仍应解析出 2 章');
        assert.equal(app.cellData.nCells.length, 2, '回退后仍应解析出 2 个小节');
        assert.equal(app.cellData.currentVideoTitle, '1.1 视频一');
    } finally {
        window.app?.destroy();
        dom.window.close();
    }
});

test('旧版页面 .prev_title 是小节名时，按知识卡 iframe 的 num 识别章节测验', () => {
    const html = `<!doctype html>
<html><head><title>学习通</title></head>
<body>
  <div class="prev_title">大学生心理健康状况及成因</div>
  <div class="prev_white">大学生心理健康状况及成因</div>
  <a href="javascript:getTeacherAjax('268192668','157461710','1266657585')">2.1 大学生心理健康状况及成因</a>
  <iframe src="/mooc-ans/knowledge/cards?clazzid=157461710&courseid=268192668&num=1&chapterId=1266657585"></iframe>
  <video id="video_html5_api"></video>
</body></html>`;
    const { dom, window, app } = createPage({
        html,
        url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1266657585&courseId=268192668&clazzid=157461710',
    });
    try {
        assert.equal(app._currentStepTitle(), '章节测验', 'num=1 的知识卡应判为章节测验，而不是 .prev_title 的小节名');
        assert.equal(app._isChapterTest(), true);
        const iframe = window.document.querySelector('iframe');
        iframe.setAttribute('src', '/mooc-ans/knowledge/cards?clazzid=157461710&courseid=268192668&num=0&chapterId=1266657585');
        assert.equal(app._currentStepTitle(), '视频', 'num=0 的知识卡应判为视频');
        assert.equal(app._isChapterTest(), false);
    } finally {
        window.app?.destroy();
        dom.window.close();
    }
});

test('新版页面目录只有 getTeacherAjax 链接时也能解析出章节与当前小节', () => {
    const { dom, window, app } = createPage({
        html: LINK_PAGE_HTML,
        url: 'https://mooc1-2.chaoxing.com/mooc-ans/mycourse/studentstudy?chapterId=1266657450&courseId=268192668&clazzid=157461710',
    });
    try {
        assert.equal(app._getChapterNodes().length, 0, '新版页面没有 .posCatalog_select，旧解析应为空');
        assert.equal(app.cellData.cells.length, 2, '应能按链接章号分出 2 章');
        assert.equal(app.cellData.nCells.length, 2, '第一章应有 2 个小节');
        assert.equal(app.cellData.currentCellIndex, 0);
        assert.equal(app.cellData.currentNCellIndex, 0);
        assert.equal(app.cellData.currentVideoTitle, '1.1 何为心理健康', '应按 URL 里的 chapterId 定位当前小节');
        assert.equal(app._currentSectionKey(), '0|0', '有目录数据后小节键应可用');
        assert.ok(app._positionKey(), '有目录数据后应能写入断点续播的位置键');
        const next = app._computeNextNode();
        assert.deepEqual({ ...next }, { c: 0, n: 1 });

        const sections = app.cellData.cells[0].querySelectorAll('.posCatalog_select:not(.firstLayer)');
        assert.equal(sections.length, 2);
        assert.equal(sections[0].classList.contains('posCatalog_active'), true, 'chapterId 命中的小节应标为当前');
        assert.equal(sections[1].classList.contains('posCatalog_active'), false);
        const anchor = sections[1].querySelector('.posCatalog_name');
        assert.ok(anchor && anchor.tagName === 'A', '小节名应指向真实链接，供点击跳转');
        assert.ok(String(anchor.getAttribute('href')).includes('getTeacherAjax'), '链接应保留 getTeacherAjax 跳转');
    } finally {
        window.app?.destroy();
        dom.window.close();
    }
});
