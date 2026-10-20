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

/** 创建一个尽量接近真实学习通播放页的 jsdom 环境，并加载 V3 产物。 */
function createPage() {
    const dom = new JSDOM(PAGE_HTML, {
        url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=100&clazzid=1',
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
