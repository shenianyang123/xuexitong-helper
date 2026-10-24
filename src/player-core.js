/* 学习通播放核心（无 jQuery 依赖）
 *
 * 由 scripts/build.mjs 内联进 v3_optimized.js 与 deepseek-console/xuexitong-console.js。
 * 对外只暴露 createPlayerApp(PAGE, entryOptions)，返回 app 对象；
 * app 的公开 API 与原 v3（window.app）保持兼容：run / nextUnit / configs / cellData / destroy。
 */

function createPlayerApp(PAGE, entryOptions) {
    "use strict";

    var OPTIONS = Object.assign({
        productName: "学习通自动播放助手",
        version: "__XXT_VERSION__",
        playbackRate: 1.5,
        muteVideo: false,
        autoResume: true
    }, entryOptions || {});

    var DOC = PAGE.document;
    var HUD_ID = "xuexitong-helper-hud";

    var STORAGE_KEYS = {
        settings: "xuexitong.helper.settings.v1",
        progress: "xuexitong.helper.progress.v1",
        positions: "xuexitong.helper.positions.v1"
    };

    var DEFAULT_SETTINGS = {
        playbackRate: OPTIONS.playbackRate,
        autoplay: true,
        autoAdvanceNoVideo: false,
        playAllVideosInSection: true,
        maxVideosPerSection: 8,
        sectionAdvanceDelayMs: 4000,
        muteVideo: OPTIONS.muteVideo,
        hud: true,
        hudCollapsed: true,
        hudPosition: null,
        autoResume: OPTIONS.autoResume,
        resumePosition: true,
        keepAlive: true,
        diag: true,
        diagHud: false,
        videoCheckInterval: 1000,
        guardNoProgressMs: 7000,
        guardResumeCooldownMs: 1500,
        retryInterval: 2000,
        maxRetries: 10
    };

    /* ------------------------------------------------------------------ *
     * 基础工具
     * ------------------------------------------------------------------ */

    function readJson(key, fallback) {
        try {
            var raw = PAGE.localStorage.getItem(key);
            if (!raw) return fallback;
            var parsed = JSON.parse(raw);
            return parsed && typeof parsed === "object" ? parsed : fallback;
        } catch (error) {
            return fallback;
        }
    }

    function writeJson(key, value) {
        try {
            PAGE.localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (error) {
            return false;
        }
    }

    function formatTime(seconds) {
        var total = Math.max(0, Math.floor(Number(seconds) || 0));
        var h = Math.floor(total / 3600);
        var m = Math.floor((total % 3600) / 60);
        var s = total % 60;
        var mm = h > 0 ? String(m).padStart(2, "0") : String(m);
        return (h > 0 ? h + ":" : "") + mm + ":" + String(s).padStart(2, "0");
    }

    function isVisible(element) {
        if (!element || !element.isConnected) return false;
        try {
            if (typeof element.getClientRects === "function" && element.getClientRects().length === 0) return false;
            var view = (element.ownerDocument && element.ownerDocument.defaultView) || PAGE;
            var style = view && view.getComputedStyle ? view.getComputedStyle(element) : null;
            if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) return false;
        } catch (error) {
            /* 跨域/未渲染时忽略 */
        }
        return true;
    }

    function dispatchClick(element) {
        if (!element) return false;
        try {
            var view = (element.ownerDocument && element.ownerDocument.defaultView) || PAGE;
            var event = new view.MouseEvent("click", { bubbles: true, cancelable: true, view: view });
            element.dispatchEvent(event);
            return true;
        } catch (error) {
            try {
                element.click();
                return true;
            } catch (fallbackError) {
                return false;
            }
        }
    }

    function normalizeText(text) {
        return String(text || "").replace(/\s+/g, " ").trim();
    }

    /* ------------------------------------------------------------------ *
     * 设置：Proxy 直写即持久化，兼容 README 里 app.configs.xxx = value 的用法
     * ------------------------------------------------------------------ */

    var settings = new Proxy(loadSettings(), {
        set: function (target, key, value) {
            if (typeof key !== "string" || !(key in DEFAULT_SETTINGS)) return true;
            target[key] = value;
            schedulePersistSettings();
            return true;
        }
    });

    var persistTimer = null;

    function loadSettings() {
        var stored = readJson(STORAGE_KEYS.settings, {});
        var merged = {};
        Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
            merged[key] = DEFAULT_SETTINGS[key];
            if (stored[key] !== undefined && typeof stored[key] === typeof DEFAULT_SETTINGS[key]) {
                merged[key] = stored[key];
            }
        });
        return merged;
    }

    function schedulePersistSettings() {
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = setTimeout(function () {
            persistTimer = null;
            persistSettings();
        }, 200);
    }

    function persistSettings() {
        var snapshot = {};
        Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
            snapshot[key] = settings[key];
        });
        writeJson(STORAGE_KEYS.settings, snapshot);
    }

    /* ------------------------------------------------------------------ *
     * 自检（诊断）：把页面结构 / 视频状态写进 localStorage，
     * 方便在站点改版后离线读取（Edge 里读 leveldb 即可），不用反复手动粘贴。
     * ------------------------------------------------------------------ */

    var DIAG_KEY = "xuexitong.helper.diag.v1";

    function safeValue(fn, fallback) {
        try {
            var value = fn();
            return value === undefined ? fallback : value;
        } catch (error) {
            return fallback;
        }
    }

    function outlineNode(el) {
        if (!el || !el.tagName) return "";
        var cls = typeof el.className === "string" ? el.className : "";
        cls = String(cls || "").replace(/\s+/g, ".").replace(/^\.+|\.+$/g, "");
        return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (cls ? "." + cls : "");
    }

    function domOutline(doc, limit) {
        var lines = [];
        var root = doc && (doc.body || doc.documentElement);
        function walk(el, depth, prefix) {
            if (!el || depth > 3 || lines.length >= limit) return;
            var kids = el.children || [];
            for (var i = 0; i < kids.length; i++) {
                if (lines.length >= limit) return;
                lines.push(prefix + outlineNode(kids[i]));
                walk(kids[i], depth + 1, "  " + prefix);
            }
        }
        walk(root, 0, "");
        return lines;
    }

    function catalogClassTokens(doc, limit) {
        var out = [];
        var seen = {};
        var nodes = [];
        try {
            nodes = doc.querySelectorAll('[class*="atalog"],[class*="hapter"],[class*="video"],[class*="node"]');
        } catch (error) {
            return out;
        }
        for (var i = 0; i < nodes.length && out.length < limit; i++) {
            var cls = String(nodes[i].className || "");
            if (!cls) continue;
            var tokens = cls.split(/\s+/);
            for (var j = 0; j < tokens.length && out.length < limit; j++) {
                var token = tokens[j];
                if (!token || seen[token]) continue;
                seen[token] = 1;
                out.push(token);
            }
        }
        return out;
    }

    function scanFrames(doc, depth, path, out) {
        if (!doc || depth > 2) return;
        var frames = safeValue(function () { return doc.querySelectorAll("iframe"); }, []) || [];
        for (var i = 0; i < frames.length && out.length < 12; i++) {
            var frame = frames[i];
            var info = {
                path: path + "iframe[" + i + "]",
                id: frame.id || "",
                cls: String(typeof frame.className === "string" ? frame.className : ""),
                src: String(frame.getAttribute("src") || "").slice(0, 200)
            };
            var inner = safeValue(function () { return frame.contentDocument; }, null);
            info.readable = Boolean(inner);
            if (inner) {
                info.hasTree = Boolean(safeValue(function () { return inner.querySelector("#coursetree"); }, null));
                info.catalogCount = safeValue(function () { return inner.querySelectorAll(".posCatalog_select").length; }, -1);
                info.videoCount = safeValue(function () { return inner.querySelectorAll("video").length; }, -1);
                info.videos = safeValue(function () {
                    return Array.prototype.slice.call(inner.querySelectorAll("video")).slice(0, 3).map(function (v) {
                        return {
                            t: Number(v.currentTime) || 0,
                            d: Number(v.duration) || 0,
                            rate: safeValue(function () { return v.playbackRate; }, null),
                            paused: Boolean(v.paused),
                            src: String(v.currentSrc || v.src || "").slice(0, 120)
                        };
                    });
                }, []);
                info.outline = domOutline(inner, 20);
                scanFrames(inner, depth + 1, info.path + "/", out);
            }
            out.push(info);
        }
    }

    /* ------------------------------------------------------------------ *
     * 进度记录
     * ------------------------------------------------------------------ */

    function loadProgress() {
        var raw = readJson(STORAGE_KEYS.progress, {});
        var progress = {
            updatedAt: Number(raw.updatedAt) || 0,
            sections: raw.sections && typeof raw.sections === "object" ? raw.sections : {},
            resumeTarget: null
        };
        var target = raw.resumeTarget;
        if (target && Number.isFinite(Number(target.c)) && Number.isFinite(Number(target.n))) {
            progress.resumeTarget = {
                c: Math.max(0, Math.floor(Number(target.c))),
                n: Math.max(0, Math.floor(Number(target.n))),
                title: String(target.title || "")
            };
        }
        return progress;
    }

    function saveProgress(progress) {
        progress.updatedAt = Date.now();
        var keys = Object.keys(progress.sections);
        if (keys.length > 2000) {
            keys.sort(function (a, b) {
                return (progress.sections[a].at || 0) - (progress.sections[b].at || 0);
            });
            keys.slice(0, keys.length - 2000).forEach(function (key) {
                delete progress.sections[key];
            });
        }
        writeJson(STORAGE_KEYS.progress, progress);
    }

    /* ------------------------------------------------------------------ *
     * HUD：悬浮球 + 展开式功能菜单（Shadow DOM 隔离样式）
     * ------------------------------------------------------------------ */

    var HUD_CSS = [
        ":host{all:initial}",
        "*{box-sizing:border-box}",
        ".xxt-root{font:13px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;color:#e6edf3}",
        ".xxt-ball{position:relative;width:54px;height:54px;padding:0;border-radius:50%;border:1px solid rgba(255,255,255,.22);",
        "background:radial-gradient(circle at 32% 28%,#3d8bfd,#1f4fa8);color:#fff;font-size:19px;line-height:1;",
        "display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;-webkit-user-select:none;",
        "box-shadow:0 10px 26px rgba(0,0,0,.45),0 0 0 6px rgba(31,111,235,.12);touch-action:none}",
        ".xxt-ball:hover{filter:brightness(1.08)}",
        ".xxt-ball[data-playing='1']{background:radial-gradient(circle at 32% 28%,#4ade80,#15803d)}",
        ".xxt-ball[data-paused='1']{background:radial-gradient(circle at 32% 28%,#fbbf24,#a16207)}",
        ".xxt-ball[data-error='1']{background:radial-gradient(circle at 32% 28%,#f87171,#991b1b)}",
        ".xxt-badge{position:absolute;right:-4px;bottom:-4px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;",
        "background:#0d1117;border:1px solid rgba(255,255,255,.28);font-size:10px;line-height:18px;text-align:center;color:#e6edf3}",
        ".xxt-badge:empty{display:none}",
        ".xxt-panel{position:fixed;width:290px;color:#e6edf3;background:rgba(20,25,32,.97);",
        "border:1px solid rgba(255,255,255,.14);border-radius:12px;box-shadow:0 16px 40px rgba(0,0,0,.5);",
        "overflow:hidden;display:none}",
        ".xxt-panel[data-open='1']{display:block}",
        ".xxt-head{display:flex;align-items:center;gap:8px;padding:8px 10px 8px 12px;",
        "background:linear-gradient(90deg,rgba(31,111,235,.4),rgba(31,111,235,.05));border-bottom:1px solid rgba(255,255,255,.08)}",
        ".xxt-dot{width:8px;height:8px;border-radius:50%;background:#8b949e;flex:0 0 auto}",
        ".xxt-dot.is-playing{background:#3fb950;box-shadow:0 0 0 3px rgba(63,185,80,.18)}",
        ".xxt-dot.is-paused{background:#d29922}",
        ".xxt-title{flex:1 1 auto;font-weight:600;font-size:13px;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".xxt-fold{width:22px;height:22px;padding:0;border:0;border-radius:6px;background:rgba(255,255,255,.08);",
        "color:#e6edf3;font-size:14px;line-height:1;cursor:pointer}",
        ".xxt-fold:hover{background:rgba(255,255,255,.18)}",
        ".xxt-body{padding:8px 12px 10px}",
        ".xxt-row{display:flex;align-items:baseline;gap:8px;margin:3px 0}",
        ".xxt-label{flex:0 0 34px;color:#8b949e;font-size:12px}",
        ".xxt-value{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".xxt-bar{height:5px;border-radius:3px;background:rgba(255,255,255,.12);margin:6px 0;overflow:hidden}",
        ".xxt-bar-inner{height:100%;width:0;background:linear-gradient(90deg,#1f6feb,#3fb950);transition:width .3s ease}",
        ".xxt-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:8px 0 4px}",
        ".xxt-speed{display:flex;align-items:center;gap:4px;color:#8b949e;font-size:12px}",
        ".xxt-select{background:#21262d;color:#e6edf3;border:1px solid rgba(255,255,255,.18);border-radius:6px;",
        "padding:3px 4px;font-size:12px;outline:none}",
        ".xxt-btn{border:1px solid rgba(255,255,255,.18);border-radius:6px;background:#21262d;color:#e6edf3;",
        "padding:4px 8px;font-size:12px;cursor:pointer}",
        ".xxt-btn:hover{background:#30363d}",
        ".xxt-btn:active{transform:translateY(1px)}",
        ".xxt-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:6px 0 2px}",
        ".xxt-pill{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:4px 7px;",
        "border-radius:6px;border:1px solid rgba(255,255,255,.14);background:#161b22;color:#c9d1d9;",
        "font-size:12px;cursor:pointer}",
        ".xxt-pill:hover{background:#1f2630}",
        ".xxt-pill.is-on{border-color:rgba(86,155,255,.65);background:rgba(31,111,235,.28);color:#e6edf3}",
        ".xxt-pill-state{color:#8b949e;font-size:11px}",
        ".xxt-pill.is-on .xxt-pill-state{color:#79c0ff}",
        ".xxt-logs{margin-top:4px;max-height:64px;overflow:hidden;border-top:1px solid rgba(255,255,255,.08);padding-top:5px}",
        ".xxt-log{font-size:11px;line-height:1.45;color:#8b949e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".xxt-log-ok{color:#3fb950}",
        ".xxt-log-warn{color:#d29922}",
        ".xxt-log-error{color:#f85149}",
        ".xxt-diag{display:none;margin-top:4px;font-size:9px;line-height:1.3;color:#7ee787;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto}",
        '.xxt-panel[data-diag="1"] .xxt-diag{display:block}'
    ].join("");

    var HUD_HTML = [
        '<div class="xxt-root">',
        '  <div class="xxt-panel" data-open="0">',
        '    <div class="xxt-head">',
        '      <span class="xxt-dot"></span>',
        '      <span class="xxt-title"></span>',
        '      <button class="xxt-fold" type="button" title="收起为悬浮球">×</button>',
        "    </div>",
        '    <div class="xxt-body">',
        '      <div class="xxt-row"><span class="xxt-label">状态</span><span class="xxt-value xxt-status">初始化</span></div>',
        '      <div class="xxt-row"><span class="xxt-label">章节</span><span class="xxt-value xxt-section">—</span></div>',
        '      <div class="xxt-row"><span class="xxt-label">视频</span><span class="xxt-value xxt-video">—</span></div>',
        '      <div class="xxt-bar"><div class="xxt-bar-inner"></div></div>',
        '      <div class="xxt-row"><span class="xxt-label">进度</span><span class="xxt-value xxt-progress">已完成 0 节</span></div>',
        '      <div class="xxt-actions">',
        '        <label class="xxt-speed">倍速',
        '          <select class="xxt-select">',
        '            <option value="0.75">0.75x</option>',
        '            <option value="1">1.0x</option>',
        '            <option value="1.25">1.25x</option>',
        '            <option value="1.5">1.5x</option>',
        '            <option value="2">2.0x</option>',
        "          </select>",
        "        </label>",
        '        <button class="xxt-btn xxt-toggle" type="button">暂停</button>',
        '        <button class="xxt-btn xxt-next" type="button">下一节</button>',
        '        <button class="xxt-btn xxt-reset" type="button">重置进度</button>',
        "      </div>",
        '      <div class="xxt-grid">',
        '        <button class="xxt-pill" type="button" data-setting="autoplay">自动播放<span class="xxt-pill-state"></span></button>',
        '        <button class="xxt-pill" type="button" data-setting="playAllVideosInSection">多段接力<span class="xxt-pill-state"></span></button>',
        '        <button class="xxt-pill" type="button" data-setting="muteVideo">静音<span class="xxt-pill-state"></span></button>',
        '        <button class="xxt-pill" type="button" data-setting="autoAdvanceNoVideo">跳过无视频<span class="xxt-pill-state"></span></button>',
        "      </div>",
        '      <div class="xxt-logs"></div>',
        '      <pre class="xxt-diag"></pre>',
        "    </div>",
        "  </div>",
        '  <button class="xxt-ball" type="button" title="学习通助手：点击展开功能菜单">',
        '    <span class="xxt-ball-icon">▶</span>',
        '    <span class="xxt-badge"></span>',
        "  </button>",
        "</div>"
    ].join("\n");

    /** 悬浮球状态：常态是球，点开是功能菜单；拒绝在页面里永久占一块面板。 */
    function createHud(app) {
        var host = DOC.createElement("div");
        host.id = HUD_ID;
        host.setAttribute("data-xuexitong-helper", "hud");
        host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483646;pointer-events:auto;";

        var root;
        if (typeof host.attachShadow === "function") {
            var shadow = host.attachShadow({ mode: "open" });
            shadow.innerHTML = "<style>" + HUD_CSS + "</style>" + HUD_HTML;
            root = shadow;
        } else {
            host.innerHTML = "<style>" + HUD_CSS + "</style>" + HUD_HTML;
            root = host;
        }

        var panel = root.querySelector(".xxt-panel");
        var ball = root.querySelector(".xxt-ball");
        var els = {
            dot: root.querySelector(".xxt-dot"),
            title: root.querySelector(".xxt-title"),
            status: root.querySelector(".xxt-status"),
            section: root.querySelector(".xxt-section"),
            video: root.querySelector(".xxt-video"),
            bar: root.querySelector(".xxt-bar-inner"),
            progress: root.querySelector(".xxt-progress"),
            logs: root.querySelector(".xxt-logs"),
            diag: root.querySelector(".xxt-diag"),
            panel: panel,
            fold: root.querySelector(".xxt-fold"),
            toggle: root.querySelector(".xxt-toggle"),
            next: root.querySelector(".xxt-next"),
            reset: root.querySelector(".xxt-reset"),
            select: root.querySelector(".xxt-select"),
            icon: root.querySelector(".xxt-ball-icon"),
            badge: root.querySelector(".xxt-badge"),
            pills: Array.prototype.slice.call(root.querySelectorAll(".xxt-pill"))
        };
        els.title.textContent = OPTIONS.productName;
        els.select.value = String(settings.playbackRate);

        var mounted = false;
        var resetArmedAt = 0;
        var drag = null;
        var suppressClick = false;

        function mount() {
            if (mounted) return;
            var parent = DOC.body || DOC.documentElement;
            if (!parent) return;
            parent.appendChild(host);
            mounted = true;
            restorePosition();
        }

        function restorePosition() {
            var saved = settings.hudPosition;
            var view = PAGE || {};
            if (!saved || typeof saved !== "object") return;
            var left = Number(saved.left);
            var top = Number(saved.top);
            if (!isFinite(left) || !isFinite(top)) return;
            var maxLeft = (Number(view.innerWidth) || 1024) - 60;
            var maxTop = (Number(view.innerHeight) || 768) - 60;
            host.style.left = Math.max(4, Math.min(maxLeft, left)) + "px";
            host.style.top = Math.max(4, Math.min(maxTop, top)) + "px";
            host.style.right = "auto";
            host.style.bottom = "auto";
        }

        /** 菜单贴着球打开：球在右半边就向左展开，空间不够就翻到下方。 */
        function positionPanel() {
            panel.style.left = "0px";
            panel.style.top = "0px";
            var rect = host.getBoundingClientRect ? host.getBoundingClientRect() : null;
            var vw = Number(PAGE && PAGE.innerWidth) || 1024;
            var vh = Number(PAGE && PAGE.innerHeight) || 768;
            var pw = Number(panel.offsetWidth) || 290;
            var ph = Number(panel.offsetHeight) || 340;
            var anchorLeft = rect ? rect.left : 16;
            var anchorTop = rect ? rect.top : 16;
            var anchorRight = rect ? rect.right : anchorLeft + 54;
            var anchorBottom = rect ? rect.bottom : anchorTop + 54;
            var left = anchorRight + 10;
            if (left + pw > vw - 8) left = anchorLeft - pw - 10;
            if (left < 8) left = Math.max(8, Math.min(vw - pw - 8, anchorLeft + 54 - pw));
            var top = anchorBottom - ph;
            if (top < 8) top = anchorTop;
            top = Math.max(8, Math.min((Number(PAGE && PAGE.innerHeight) || 768) - ph - 8, top));
            panel.style.left = Math.round(left) + "px";
            panel.style.top = Math.round(top) + "px";
        }

        function setOpen(open) {
            panel.setAttribute("data-open", open ? "1" : "0");
            if (open) positionPanel();
        }

        function setLogs(lines) {
            els.logs.textContent = "";
            (lines || []).slice(-4).forEach(function (line) {
                var div = DOC.createElement("div");
                div.className = "xxt-log xxt-log-" + (line.level || "info");
                div.textContent = line.text;
                els.logs.appendChild(div);
            });
        }

        function update(data) {
            if (!data) return;
            els.status.textContent = data.status || "—";
            els.dot.className = "xxt-dot" + (data.playing ? " is-playing" : (data.paused ? " is-paused" : ""));
            els.section.textContent = data.section || "—";
            els.section.setAttribute("title", data.title || "");
            els.video.textContent = data.video || "—";
            els.bar.style.width = (Math.max(0, Math.min(100, Number(data.percent) || 0))).toFixed(1) + "%";
            els.progress.textContent = "已完成 " + (Number(data.completed) || 0) + " 节";
            els.toggle.textContent = data.paused ? "继续" : "暂停";
            els.icon.textContent = data.paused ? "⏸" : (data.playing ? "▶" : "•");
            els.badge.textContent = data.badge || "";
            ball.setAttribute("data-playing", data.playing ? "1" : "0");
            ball.setAttribute("data-paused", !data.playing && data.paused ? "1" : "0");
            ball.setAttribute("data-error", /失败|错误|停止/.test(String(data.status || "")) ? "1" : "0");
            var rate = String(data.rate || "");
            var hasOption = Array.prototype.some.call(els.select.options, function (option) {
                return option.value === rate;
            });
            if (hasOption) els.select.value = rate;
            els.pills.forEach(function (pill) {
                var key = pill.getAttribute("data-setting");
                var on = Boolean(app.configs[key]);
                pill.classList.toggle("is-on", on);
                var state = pill.querySelector(".xxt-pill-state");
                if (state) state.textContent = on ? "开" : "关";
            });
            setLogs(data.logs);
        }

        function openPanel() {
            setOpen(true);
            app.configs.hudCollapsed = false;
        }

        function closePanel() {
            setOpen(false);
            app.configs.hudCollapsed = true;
        }

        function togglePanel() {
            if (panel.getAttribute("data-open") === "1") closePanel();
            else openPanel();
        }

        /* ---------------- 拖拽悬浮球 ---------------- */

        function onDragMove(event) {
            if (!drag) return;
            var dx = (event.clientX || 0) - drag.startX;
            var dy = (event.clientY || 0) - drag.startY;
            if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
            drag.moved = true;
            var vw = Number(PAGE && PAGE.innerWidth) || 1024;
            var vh = Number(PAGE && PAGE.innerHeight) || 768;
            var left = Math.max(4, Math.min(vw - 58, drag.left + dx));
            var top = Math.max(4, Math.min(vh - 58, drag.top + dy));
            host.style.left = Math.round(left) + "px";
            host.style.top = Math.round(top) + "px";
            host.style.right = "auto";
            host.style.bottom = "auto";
        }

        function onDragEnd() {
            PAGE.removeEventListener("mousemove", onDragMove, true);
            PAGE.removeEventListener("mouseup", onDragEnd, true);
            if (drag && drag.moved) {
                suppressClick = true;
                settings.hudPosition = {
                    left: Number.parseInt(host.style.left, 10) || 0,
                    top: Number.parseInt(host.style.top, 10) || 0
                };
                if (panel.getAttribute("data-open") === "1") positionPanel();
            }
            drag = null;
        }

        ball.addEventListener("mousedown", function (event) {
            if (event.button !== undefined && event.button !== 0) return;
            var rect = host.getBoundingClientRect ? host.getBoundingClientRect() : { left: 0, top: 0 };
            drag = {
                startX: event.clientX || 0,
                startY: event.clientY || 0,
                left: rect.left,
                top: rect.top,
                moved: false
            };
            suppressClick = false;
            PAGE.addEventListener("mousemove", onDragMove, true);
            PAGE.addEventListener("mouseup", onDragEnd, true);
        });

        ball.addEventListener("click", function (event) {
            event.stopPropagation();
            if (suppressClick) {
                suppressClick = false;
                return;
            }
            togglePanel();
        });

        els.fold.addEventListener("click", closePanel);
        els.toggle.addEventListener("click", function () {
            app.togglePause();
        });
        els.next.addEventListener("click", function () {
            try {
                app.nextUnit();
            } catch (error) {
                app._note("切换下一节失败：" + (error && error.message ? error.message : error), "error");
            }
        });
        els.select.addEventListener("change", function () {
            var rate = Number(els.select.value) || 1;
            app.updateSettings({ playbackRate: rate });
            app._note("播放速度设为 " + rate + "x", "info");
        });
        els.reset.addEventListener("click", function () {
            var now = Date.now();
            if (now - resetArmedAt > 3000) {
                resetArmedAt = now;
                els.reset.textContent = "再点确认";
                return;
            }
            resetArmedAt = 0;
            els.reset.textContent = "重置进度";
            app.resetProgress();
        });
        els.pills.forEach(function (pill) {
            pill.addEventListener("click", function () {
                var key = pill.getAttribute("data-setting");
                if (!key) return;
                var next = !app.configs[key];
                var patch = {};
                patch[key] = next;
                app.updateSettings(patch);
                app._note((pill.textContent || key) + "：" + (next ? "开" : "关"), "info");
            });
        });

        setOpen(!settings.hudCollapsed);
        mount();

        return {
            update: update,
            open: openPanel,
            close: closePanel,
            isOpen: function () {
                return panel.getAttribute("data-open") === "1";
            },
            show: function () {
                mount();
                host.style.display = "";
            },
            hide: function () {
                host.style.display = "none";
            },
            destroy: function () {
                if (drag) onDragEnd();
                if (host.parentNode) host.parentNode.removeChild(host);
                mounted = false;
            }
        };
    }

    /* ------------------------------------------------------------------ *
     * app
     * ------------------------------------------------------------------ */

    var app = {
        _destroyed: false,
        _isPlaying: false,
        _paused: false,
        _status: "初始化",
        _currentRetryCount: 0,
        _checkInterval: null,
        _nextUnitTimer: null,
        _eventVideoEl: null,
        _boundVideoHandlers: null,
        _nextUnitPending: false,
        _chapterAdvanceTimes: [],
        _cellData: {
            cells: [],
            nCells: [],
            currentCellIndex: -1,
            currentNCellIndex: -1,
            currentVideoTitle: ""
        },
        _treeContainerEl: null,
        _sectionVideoIndex: 0,
        _sectionVideoCount: 0,
        _playedSignatures: new Set(),
        _videoCache: null,
        _videoCacheTs: 0,
        _lastSectionKey: "",
        _logLines: [],
        _positions: {},
        _lastPositionSaveAt: 0,
        _lastProgressAt: 0,
        _lastResumeAt: 0,
        _hud: null,
        _hudTimer: null,
        _afterEndedTimer: null,
        _guardTimer: null,
        _stepNavHandler: null,
        _pageGuardHandlers: null,

        get cellData() {
            return this._cellData;
        },

        get configs() {
            return settings;
        },

        set configs(value) {
            if (value && typeof value === "object") this.updateSettings(value);
        },

        /* ---------------- 生命周期 ---------------- */

        run: function () {
            if (this._destroyed) return;
            try {
                this._init();
                this._ensureHud();
                this._initCellData();
                if (this._maybeResume()) return;
                this.play();
            } catch (error) {
                this._note("启动失败：" + (error && error.message ? error.message : error), "error");
                console.error("[学习通助手] 启动失败", error);
            }
        },

        _init: function () {
            this._positions = this._loadPositions();
            this._treeContainerEl = this._getTreeContainer();
            if (!this._treeContainerEl) {
                // 新版 mooc-ans 页面把目录换成了 getTeacherAjax 链接，没有 #coursetree。
                var hasCatalogLinks = false;
                try {
                    hasCatalogLinks = Boolean(DOC.querySelector('a[href*="getTeacherAjax"]'));
                } catch (error) {
                    hasCatalogLinks = false;
                }
                if (hasCatalogLinks) {
                    this._note("新版课程页：按目录链接重建章节", "info");
                } else {
                    this._note("未找到课程目录，等待页面加载", "warn");
                }
            }
            this._bindStepNavigation();
            this._setStatus("已就绪");
            this._applyUrlOverrides();
            this._writeDiagnostics("init");
        },

        destroy: function () {
            if (this._destroyed) return;
            this._destroyed = true;
            this._clearCheckInterval();
            this._clearAfterEndedTimer();
            this._unbindStepNavigation();
            this._detachVideoEvents();
            if (this._nextUnitTimer) {
                clearTimeout(this._nextUnitTimer);
                this._nextUnitTimer = null;
            }
            if (this._hudTimer) {
                clearInterval(this._hudTimer);
                this._hudTimer = null;
            }
            if (this._guardTimer) {
                clearInterval(this._guardTimer);
                this._guardTimer = null;
            }
            if (persistTimer) {
                clearTimeout(persistTimer);
                persistTimer = null;
            }
            persistSettings();
            if (this._hud) {
                this._hud.destroy();
                this._hud = null;
            }
        },

        /* ---------------- 设置 ---------------- */

        getSettings: function () {
            var out = {};
            Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
                out[key] = settings[key];
            });
            return out;
        },

        updateSettings: function (patch) {
            if (!patch || typeof patch !== "object") return this.getSettings();
            var self = this;
            Object.keys(patch).forEach(function (key) {
                if (key in DEFAULT_SETTINGS) settings[key] = patch[key];
            });
            this._applySettings();
            return this.getSettings();
        },

        _applySettings: function () {
            var video = this._getVideoEl() || this._videoEl;
            if (video) this._applyPlaybackSettings(video);
            if (this._hud) {
                if (this.configs.hud) this._hud.show();
                else this._hud.hide();
            } else if (this.configs.hud) {
                this._ensureHud();
            }
            this._updateHud();
        },

        /* ---------------- HUD ---------------- */

        _ensureHud: function () {
            if (!this.configs.hud || this._destroyed) return null;
            if (this._hud) return this._hud;
            try {
                this._hud = createHud(this);
                var self = this;
                this._hudTimer = setInterval(function () {
                    self._updateHud();
                }, 500);
            } catch (error) {
                console.warn("[学习通助手] HUD 创建失败", error);
                this._hud = null;
            }
            return this._hud;
        },

        _updateHud: function () {
            if (!this._hud) return;
            try {
                var video = this._videoEl;
                var duration = video ? Number(video.duration) || 0 : 0;
                var current = video ? Number(video.currentTime) || 0 : 0;
                var percent = duration > 0 ? (current / duration) * 100 : 0;
                var progress = loadProgress();
                var sectionText = "未定位到目录";
                if (this._cellData.currentCellIndex >= 0) {
                    sectionText = "第 " + (this._cellData.currentCellIndex + 1) + " 章 · 第 " +
                        (this._cellData.currentNCellIndex + 1) + " 节";
                }
                var videoText = "—";
                var badgeText = "";
                if (this._sectionVideoCount > 1) {
                    videoText = "第 " + (this._sectionVideoIndex + 1) + " / " + this._sectionVideoCount + " 个";
                    badgeText = (this._sectionVideoIndex + 1) + "/" + this._sectionVideoCount;
                } else if (video) {
                    videoText = formatTime(current) + " / " + formatTime(duration);
                    if (duration > 0) badgeText = Math.round(percent) + "%";
                }
                this._hud.update({
                    status: this._status,
                    section: sectionText,
                    title: this._cellData.currentVideoTitle || "",
                    video: videoText,
                    badge: badgeText,
                    percent: percent,
                    completed: Object.keys(progress.sections).length,
                    paused: this._paused,
                    playing: this._isPlaying,
                    rate: Number(this.configs.playbackRate),
                    logs: this._logLines
                });
            } catch (error) {
                /* HUD 渲染失败不影响播放 */
            }
        },

        _setStatus: function (status) {
            this._status = String(status || "");
            this._updateHud();
        },

        _note: function (text, level) {
            var line = { text: String(text || ""), level: level || "info", at: Date.now() };
            this._logLines.push(line);
            if (this._logLines.length > 30) this._logLines.splice(0, this._logLines.length - 30);
            var prefix = "[学习通助手]";
            if (level === "error") console.error(prefix, line.text);
            else if (level === "warn") console.warn(prefix, line.text);
            else console.log(prefix, line.text);
            this._updateHud();
        },

        /* ---------------- 课程目录 ---------------- */

        /** 新版 mooc-ans 学生页的目录：小节是调用 getTeacherAjax(...) 的 <a>，
         *  已经没有 #coursetree / .posCatalog_select。这里按链接重建一套只读目录模型，
         *  供 _initCellData / 断点续播 / 下一节复用（模型元素仍指向真实 <a>，点击即可跳转）。 */
        _currentChapterIdFromUrl: function () {
            var match = /[?&]chapterId=(\d+)/.exec(String(safeValue(function () { return PAGE.location.search; }, "")));
            return match ? match[1] : "";
        },

        _chapterIdFromHref: function (href) {
            var match = /getTeacherAjax\(([^)]*)\)/.exec(String(href || ""));
            if (!match) return "";
            var args = match[1].split(",").map(function (part) {
                return part.replace(/['"\s]/g, "");
            });
            return args.length >= 3 ? args[2] : "";
        },

        _buildLinkCatalogCells: function () {
            var anchors = [];
            try {
                anchors = Array.prototype.slice.call(DOC.querySelectorAll('a[href*="getTeacherAjax"]'));
            } catch (error) {
                return [];
            }
            if (!anchors.length) return [];
            var currentId = this._currentChapterIdFromUrl();
            var groups = [];
            var items = [];
            var lastNo = null;
            anchors.forEach(function (anchor) {
                var title = normalizeText(anchor.textContent || "");
                var match = /^(\d+)(?:[.．\s]|$)/.exec(title);
                if (!title || !match) return;
                var no = match[1];
                var item = {
                    anchor: anchor,
                    title: title,
                    no: no,
                    chapterId: this._chapterIdFromHref(anchor.getAttribute("href"))
                };
                items.push(item);
                if (!groups.length || no !== lastNo) {
                    groups.push({ no: no, items: [] });
                    lastNo = no;
                }
                groups[groups.length - 1].items.push(item);
            }, this);
            if (!groups.length) return [];
            var active = null;
            if (currentId) {
                items.forEach(function (item) {
                    if (item.chapterId === currentId) active = item;
                });
            }
            if (!active) {
                var pageTitle = normalizeText(String(safeValue(function () { return DOC.title; }, "")));
                var heading = "";
                try {
                    var headingNode = DOC.querySelector(".videoTitle, .prev_title, .chapter_title, #videoTitle");
                    heading = normalizeText((headingNode && headingNode.textContent) || "");
                } catch (error) {
                    heading = "";
                }
                items.forEach(function (item) {
                    if (active) return;
                    var suffix = normalizeText(item.title.replace(/^\d+(?:[.．]\d+)?\s*/, ""));
                    if (!suffix || suffix.length < 2) return;
                    if ((heading && heading.indexOf(suffix) >= 0) || pageTitle.indexOf(suffix) >= 0) active = item;
                });
            }
            var cells = groups.map(function (group) {
                var sections = group.items.map(function (item) {
                    return {
                        __xxtLink: item.anchor,
                        title: item.title,
                        chapterId: item.chapterId,
                        classList: {
                            contains: function (cls) {
                                return cls === "posCatalog_active" ? item === active : false;
                            }
                        },
                        querySelector: function (sel) {
                            return sel === ".posCatalog_name" ? item.anchor : null;
                        },
                        querySelectorAll: function () {
                            return [];
                        },
                        getAttribute: function (name) {
                            return name === "title" ? item.title : item.anchor.getAttribute(name);
                        },
                        textContent: item.title
                    };
                });
                return {
                    __xxtChapter: true,
                    title: "第" + group.no + "章",
                    classList: {
                        contains: function () {
                            return false;
                        }
                    },
                    querySelector: function () {
                        return null;
                    },
                    querySelectorAll: function (sel) {
                        return String(sel || "").indexOf(".posCatalog_select") >= 0 ? sections : [];
                    },
                    getAttribute: function () {
                        return null;
                    },
                    textContent: "第" + group.no + "章"
                };
            });
            this._linkCatalogSize = items.length;
            return cells;
        },

        _getTreeContainer: function () {
            var direct = DOC.querySelector("#coursetree");
            if (direct) return direct;
            // 站点改版后目录容器可能换了 id/class：退化为「包含全部 posCatalog_select 的最近祖先」
            var marks = DOC.querySelectorAll(".posCatalog_select");
            if (!marks.length) return null;
            var node = marks[0].parentElement;
            var guard = 0;
            while (node && node !== DOC.body && guard++ < 15) {
                var containsAll = node.querySelectorAll(".posCatalog_select").length >= marks.length;
                // 跳过 ul/ol：目录容器的第一层 <ul> 里放的是章节 <li>，容器本身应该是它的父元素
                if (containsAll && node.tagName !== "UL" && node.tagName !== "OL") return node;
                node = node.parentElement;
            }
            return null;
        },

        _getChapterNodes: function () {
            this._treeContainerEl = this._getTreeContainer() || this._treeContainerEl;
            var tree = this._treeContainerEl;
            if (tree) {
                var firstUl = tree.querySelector(":scope > ul") || tree.querySelector("ul");
                if (firstUl) {
                    var items = Array.prototype.filter.call(firstUl.children, function (child) {
                        return child.tagName === "LI";
                    });
                    if (items.length) return items;
                }
            }
            // 回退：把每个 .posCatalog_select.firstLayer 所在的 <li> 当作章节
            var layers = Array.prototype.slice.call(DOC.querySelectorAll(".posCatalog_select.firstLayer"));
            var chapters = [];
            layers.forEach(function (layer) {
                var li = layer;
                while (li && li.tagName !== "LI") li = li.parentElement;
                if (!li || li.tagName !== "LI" || chapters.indexOf(li) >= 0) return;
                chapters.push(li);
            });
            return chapters;
        },

        _getSectionNodes: function (chapter) {
            if (!chapter || typeof chapter.querySelectorAll !== "function") return [];
            return Array.prototype.slice.call(chapter.querySelectorAll(".posCatalog_select:not(.firstLayer)"));
        },

        _initCellData: function () {
            var cells = this._getChapterNodes();
            if (!cells.length) cells = this._buildLinkCatalogCells();
            this._cellData.cells = cells;
            this._cellData.nCells = [];
            this._cellData.currentCellIndex = -1;
            this._cellData.currentNCellIndex = -1;
            this._cellData.currentVideoTitle = "";
            for (var i = 0; i < cells.length; i++) {
                var nCells = this._getSectionNodes(cells[i]);
                this._cellData.nCells = nCells;
                this._cellData.currentCellIndex = i;
                var found = false;
                for (var j = 0; j < nCells.length; j++) {
                    if (nCells[j].classList.contains("posCatalog_active")) {
                        this._cellData.currentNCellIndex = j;
                        var nameEl = nCells[j].querySelector(".posCatalog_name");
                        this._cellData.currentVideoTitle = normalizeText(
                            (nameEl && (nameEl.getAttribute("title") || nameEl.textContent)) || ""
                        );
                        found = true;
                        break;
                    }
                }
                if (found) break;
            }
            var key = this._currentSectionKey();
            if (key !== this._lastSectionKey) this._onSectionChanged(key);
            return this._cellData;
        },

        _onSectionChanged: function (key) {
            this._lastSectionKey = key;
            this._sectionVideoIndex = 0;
            this._sectionVideoCount = 0;
            this._playedSignatures = new Set();
            this._videoCache = null;
            this._videoCacheTs = 0;
            this._videoEl = null;
            this._clearAfterEndedTimer();
            this._detachVideoEvents();
            if (key) this._note("进入小节：" + (this._cellData.currentVideoTitle || key), "info");
            this._writeDiagnostics("section");
        },

        _currentSectionKey: function () {
            var c = this._cellData.currentCellIndex;
            var n = this._cellData.currentNCellIndex;
            if (c < 0 || n < 0) return "";
            return c + "|" + n;
        },

        _computeNextNode: function () {
            var data = this._cellData;
            if (data.currentCellIndex < 0 || data.currentNCellIndex < 0) return null;
            if (data.currentNCellIndex + 1 < data.nCells.length) {
                return { c: data.currentCellIndex, n: data.currentNCellIndex + 1 };
            }
            if (data.currentCellIndex + 1 < data.cells.length) {
                return { c: data.currentCellIndex + 1, n: 0 };
            }
            return null;
        },

        /* ---------------- 进度记录 / 断点续播 ---------------- */

        _loadPositions: function () {
            var raw = readJson(STORAGE_KEYS.positions, {});
            var out = {};
            Object.keys(raw).forEach(function (key) {
                var value = raw[key];
                if (value && Number.isFinite(Number(value.t))) {
                    out[key] = { t: Number(value.t), d: Number(value.d) || 0, at: Number(value.at) || 0 };
                }
            });
            return out;
        },

        _savePositions: function () {
            var entries = Object.keys(this._positions).map(function (key) {
                return { key: key, at: this._positions[key].at || 0 };
            }, this);
            if (entries.length > 500) {
                entries.sort(function (a, b) { return a.at - b.at; });
                var self = this;
                entries.slice(0, entries.length - 500).forEach(function (entry) {
                    delete self._positions[entry.key];
                });
            }
            writeJson(STORAGE_KEYS.positions, this._positions);
        },

        _positionKey: function (videoIndex) {
            var section = this._currentSectionKey();
            if (!section) return "";
            return section + "#" + (videoIndex || 0);
        },

        _savePosition: function (video, force) {
            if (!this.configs.resumePosition || !video) return;
            var duration = Number(video.duration);
            if (!Number.isFinite(duration) || duration <= 0) return;
            var now = Date.now();
            if (!force && now - this._lastPositionSaveAt < 5000) return;
            var key = this._positionKey(this._sectionVideoIndex);
            if (!key) return;
            this._positions[key] = {
                t: Number(video.currentTime) || 0,
                d: duration,
                at: now
            };
            this._lastPositionSaveAt = now;
            this._savePositions();
        },

        _applyResumePosition: function (video) {
            if (!this.configs.resumePosition || !video) return;
            var key = this._positionKey(this._sectionVideoIndex);
            if (!key) return;
            var saved = this._positions[key];
            if (!saved) return;
            var self = this;
            var apply = function () {
                var duration = Number(video.duration);
                if (!Number.isFinite(duration) || duration <= 0) return;
                var target = Number(saved.t) || 0;
                if (target < 3 || target > duration - 5) return;
                try {
                    if (Number(video.currentTime) < target - 1) {
                        video.currentTime = target;
                        self._note("从上次进度 " + formatTime(target) + " 继续播放", "info");
                    }
                } catch (error) {
                    /* 部分播放器禁止跳转 */
                }
            };
            if (video.readyState >= 1 && Number(video.duration) > 0) {
                apply();
            } else {
                video.addEventListener("loadedmetadata", apply, { once: true });
                this._resumePositionCleanup = function () {
                    video.removeEventListener("loadedmetadata", apply);
                };
            }
        },

        _markSectionCompleted: function () {
            var key = this._currentSectionKey();
            if (!key) return;
            var progress = loadProgress();
            progress.sections[key] = {
                title: this._cellData.currentVideoTitle || "",
                at: Date.now()
            };
            var next = this._computeNextNode();
            if (next) {
                var chapters = this._cellData.cells;
                var nextChapter = chapters[next.c];
                var nextSections = this._getSectionNodes(nextChapter);
                var nextNode = nextSections[next.n];
                var nextName = nextNode ? nextNode.querySelector(".posCatalog_name") : null;
                progress.resumeTarget = {
                    c: next.c,
                    n: next.n,
                    title: normalizeText((nextName && (nextName.getAttribute("title") || nextName.textContent)) || "")
                };
            } else {
                progress.resumeTarget = {
                    c: this._cellData.currentCellIndex,
                    n: this._cellData.currentNCellIndex,
                    title: this._cellData.currentVideoTitle
                };
            }
            saveProgress(progress);
            this._note("已记录进度，累计完成 " + Object.keys(progress.sections).length + " 节", "ok");
        },

        progress: function () {
            var progress = loadProgress();
            return {
                completed: Object.keys(progress.sections).length,
                sections: Object.keys(progress.sections).map(function (key) {
                    var item = progress.sections[key];
                    return { key: key, title: item.title || "", at: item.at || 0 };
                }),
                resumeTarget: progress.resumeTarget
            };
        },

        /** 展开悬浮球的功能菜单（控制台也可用 app.showHud() / app.hideHud()）。 */
        showHud: function (open) {
            var hud = this._ensureHud();
            if (!hud) return null;
            if (open === false) hud.close();
            else if (open === true) hud.open();
            else if (hud.isOpen()) hud.close();
            else hud.open();
            return hud;
        },

        hideHud: function () {
            if (this._hud) this._hud.close();
            return this._hud;
        },

        /** 彻底移除右下角悬浮球；app.updateSettings({ hud: true }) 可重新挂载。 */
        removeHud: function () {
            if (this._hudTimer) {
                clearInterval(this._hudTimer);
                this._hudTimer = null;
            }
            if (this._hud) {
                this._hud.destroy();
                this._hud = null;
            }
        },

        resetProgress: function () {
            try {
                PAGE.localStorage.removeItem(STORAGE_KEYS.progress);
                PAGE.localStorage.removeItem(STORAGE_KEYS.positions);
            } catch (error) {
                /* 忽略 */
            }
            this._positions = {};
            this._lastPositionSaveAt = 0;
            this._note("已清空本地进度记录", "warn");
            this._updateHud();
        },

        _maybeResume: function () {
            if (!this.configs.autoResume) return false;
            var progress = loadProgress();
            var target = progress.resumeTarget;
            var key = this._currentSectionKey();
            if (!target || !key) return false;
            if (!progress.sections[key]) return false;
            if (target.c === this._cellData.currentCellIndex && target.n === this._cellData.currentNCellIndex) return false;
            if (!this._jumpToSection(target.c, target.n)) return false;
            this._note("断点续播：跳转到第 " + (target.c + 1) + " 章第 " + (target.n + 1) + " 节", "ok");
            this._setStatus("断点续播中");
            return true;
        },

        _jumpToSection: function (cellIndex, nCellIndex) {
            var chapters = this._cellData.cells && this._cellData.cells.length
                ? this._cellData.cells
                : this._getChapterNodes();
            var chapter = chapters[cellIndex];
            if (!chapter) return false;
            var sections = this._getSectionNodes(chapter);
            var target = sections[nCellIndex] || sections[0];
            if (!target) return false;
            var nameEl = target.querySelector(".posCatalog_name");
            if (!nameEl) return false;
            this._nextUnitPending = true;
            this._isPlaying = false;
            this._clearCheckInterval();
            this._detachVideoEvents();
            this._clearAfterEndedTimer();
            this._onSectionChanged("");
            dispatchClick(nameEl);
            var self = this;
            setTimeout(function () {
                self._nextUnitPending = false;
                if (self._destroyed) return;
                try {
                    self._initCellData();
                    self.play();
                } catch (error) {
                    self._note("跳转后启动失败：" + (error && error.message ? error.message : error), "error");
                }
            }, 2500);
            return true;
        },

        /* ---------------- 视频收集 ---------------- */

        _collectVideos: function (force) {
            var now = Date.now();
            if (!force && this._videoCache && now - this._videoCacheTs < 800) return this._videoCache;
            var seen = new Set();
            var list = [];
            var visit = function (doc, depth) {
                if (!doc || depth > 3) return;
                var nodes = [];
                try {
                    nodes = Array.prototype.slice.call(doc.querySelectorAll("video"));
                } catch (error) {
                    nodes = [];
                }
                nodes.forEach(function (node) {
                    if (seen.has(node)) return;
                    seen.add(node);
                    if (typeof node.closest === "function" && node.closest("#" + HUD_ID)) return;
                    list.push(node);
                });
                var frames = [];
                try {
                    frames = Array.prototype.slice.call(doc.querySelectorAll("iframe"));
                } catch (error) {
                    frames = [];
                }
                frames.forEach(function (frame) {
                    var childDoc = null;
                    try {
                        childDoc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document) || null;
                    } catch (error) {
                        childDoc = null;
                    }
                    visit(childDoc, depth + 1);
                });
            };
            visit(DOC, 0);
            this._videoCache = list;
            this._videoCacheTs = now;
            return list;
        },

        _getVideoEl: function () {
            var videos = this._collectVideos();
            this._sectionVideoCount = videos.length;
            if (!videos.length) {
                this._videoEl = null;
                return null;
            }
            var index = Math.min(this._sectionVideoIndex, videos.length - 1);
            this._sectionVideoIndex = index;
            this._videoEl = videos[index];
            return this._videoEl;
        },

        _videoSignature: function (video) {
            if (!video) return "";
            var src = video.currentSrc || video.src || "";
            var duration = Number(video.duration);
            var durationKey = Number.isFinite(duration) && duration > 0 ? Math.round(duration * 10) : 0;
            if (!src && !durationKey) return "";
            return src + "|" + durationKey;
        },

        _findPendingVideoInSection: function () {
            var videos = this._collectVideos(true);
            for (var i = 0; i < videos.length; i++) {
                var video = videos[i];
                var signature = this._videoSignature(video);
                if (signature && this._playedSignatures.has(signature)) continue;
                var duration = Number(video.duration);
                var ready = video.readyState >= 1 || (Number.isFinite(duration) && duration > 0);
                if (!ready) continue;
                return { video: video, index: i, total: videos.length };
            }
            return null;
        },

        /* ---------------- 视频事件 ---------------- */

        _videoEventHandle: function () {
            var video = this._videoEl;
            if (!video) return;
            if (this._eventVideoEl === video) return;
            this._detachVideoEvents();
            var self = this;
            var handlers = {
                ended: function () { self._handleVideoEnded(); },
                loadedmetadata: function () { self._handleVideoLoaded(); },
                play: function () { self._handleVideoPlay(); },
                pause: function () { self._handleVideoPause(); },
                error: function () { self._handlePlayError(new Error("视频元素报错：" + (video.error && video.error.code)), true); }
            };
            Object.keys(handlers).forEach(function (name) {
                video.addEventListener(name, handlers[name]);
            });
            this._boundVideoHandlers = handlers;
            this._eventVideoEl = video;
        },

        _detachVideoEvents: function () {
            var video = this._eventVideoEl;
            var handlers = this._boundVideoHandlers;
            if (video && handlers) {
                Object.keys(handlers).forEach(function (name) {
                    video.removeEventListener(name, handlers[name]);
                });
            }
            this._eventVideoEl = null;
            this._boundVideoHandlers = null;
        },

        _handleVideoLoaded: function () {
            var video = this._videoEl;
            if (!video) return;
            this._applyPlaybackSettings(video);
            this._applyResumePosition(video);
            var duration = Number(video.duration);
            if (Number.isFinite(duration) && duration > 0) {
                this._note("视频已加载，时长 " + formatTime(duration), "info");
            }
            this._setStatus("播放中");
        },

        _handleVideoPlay: function () {
            this._isPlaying = true;
            this._paused = false;
            this._lastProgressAt = Date.now();
            this._setStatus("播放中");
            this._startVideoMonitoring();
        },

        _handleVideoPause: function () {
            if (this._paused || this._nextUnitPending) return;
            this._isPlaying = false;
            this._setStatus("已暂停（自动恢复中）");
            if (!this.configs.keepAlive) return;
            var self = this;
            setTimeout(function () {
                self._tryResumePlayback("视频被暂停");
            }, Math.max(500, Number(self.configs.guardResumeCooldownMs) || 1500));
        },

        _handleVideoEnded: function () {
            var video = this._videoEl;
            if (!video) return;
            var signature = this._videoSignature(video);
            if (signature) this._playedSignatures.add(signature);
            this._isPlaying = false;
            this._clearCheckInterval();
            this._savePosition(video, true);
            this._sectionVideoCount = this._collectVideos(true).length;
            this._note("视频播放完成", "ok");

            if (!this.configs.playAllVideosInSection) {
                this._advanceToNextUnit("视频播放完成");
                return;
            }
            var maxVideos = Math.max(1, Number(this.configs.maxVideosPerSection) || 8);
            if (this._playedSignatures.size >= maxVideos) {
                this._advanceToNextUnit("本节视频数已达上限（" + maxVideos + "）");
                return;
            }
            this._setStatus("检查本节剩余视频");
            this._detachVideoEvents();
            this._videoEl = null;
            var sectionKey = this._currentSectionKey();
            var deadline = Date.now() + Math.max(1000, Number(this.configs.sectionAdvanceDelayMs) || 4000);
            this._scheduleAfterEnded(sectionKey, deadline);
        },

        _scheduleAfterEnded: function (sectionKey, deadline) {
            if (this._destroyed || this._nextUnitPending) return;
            var currentKey = this._currentSectionKey();
            if (sectionKey && currentKey && currentKey !== sectionKey) {
                this._note("页面已自动切换到新小节", "info");
                var self = this;
                setTimeout(function () {
                    if (self._destroyed) return;
                    self._initCellData();
                    self.play();
                }, 1500);
                return;
            }
            var pending = this._findPendingVideoInSection();
            if (pending) {
                this._sectionVideoIndex = pending.index;
                this._sectionVideoCount = pending.total;
                this._videoEl = pending.video;
                this._note("本节还有视频，继续播放第 " + (pending.index + 1) + "/" + pending.total + " 个", "ok");
                this._setStatus("播放本节下一个视频");
                this.play();
                return;
            }
            if (Date.now() >= deadline) {
                this._advanceToNextUnit("本节已无可播放视频");
                return;
            }
            this._clearAfterEndedTimer();
            var self2 = this;
            this._afterEndedTimer = setTimeout(function () {
                self2._afterEndedTimer = null;
                self2._scheduleAfterEnded(sectionKey, deadline);
            }, 500);
        },

        _clearAfterEndedTimer: function () {
            if (this._afterEndedTimer) {
                clearTimeout(this._afterEndedTimer);
                this._afterEndedTimer = null;
            }
        },

        _advanceToNextUnit: function (reason) {
            if (this._destroyed || this._nextUnitPending) return;
            this._setStatus("准备切换下一节");
            this._note("本节结束：" + (reason || ""), "info");
            var self = this;
            setTimeout(function () {
                if (self._destroyed || self._nextUnitPending) return;
                try {
                    self.nextUnit(true);
                } catch (error) {
                    self._nextUnitPending = false;
                }
            }, 800);
        },

        /* ---------------- 自检 / 诊断 ---------------- */

        /** 支持 URL 参数临时覆盖：?xxtrate=2 指定倍速、?xxtdiag=0 关闭自检写入。 */
        _applyUrlOverrides: function () {
            var search = String(safeValue(function () { return PAGE.location.search; }, ""));
            var rateMatch = /[?&]xxtrate=([0-9]+(?:\.[0-9]+)?)/.exec(search);
            if (rateMatch) {
                var rate = Number(rateMatch[1]);
                if (rate >= 0.25 && rate <= 16 && rate !== Number(settings.playbackRate)) {
                    settings.playbackRate = rate;
                    this._note("URL 参数指定播放速度 " + rate + "x", "info");
                }
            }
            var diagMatch = /[?&]xxtdiag=([01])/.exec(search);
            if (diagMatch) settings.diag = diagMatch[1] === "1";
            var diagHudMatch = /[?&]xxtdiaghud=([01])/.exec(search);
            if (diagHudMatch) settings.diagHud = diagHudMatch[1] === "1";
        },

        _collectDiagnostics: function (reason) {
            var app = this;
            var video = null;
            try {
                video = this._getVideoEl();
            } catch (error) {
                video = null;
            }
            var info = {
                at: Date.now(),
                reason: String(reason || ""),
                version: String(OPTIONS.version || ""),
                href: String(safeValue(function () { return PAGE.location.href; }, "")),
                productName: String(OPTIONS.productName || ""),
                settings: this.getSettings(),
                dom: {
                    readyState: String(DOC.readyState || ""),
                    treeFound: Boolean(this._getTreeContainer()),
                    counts: {},
                    outline: domOutline(DOC, 45),
                    catalogClasses: catalogClassTokens(DOC, 25)
                },
                frames: [],
                video: null,
                cells: {
                    chapters: this._cellData && this._cellData.cells ? this._cellData.cells.length : 0,
                    sections: this._cellData && this._cellData.nCells ? this._cellData.nCells.length : 0,
                    chapterIndex: this._cellData ? this._cellData.currentCellIndex : -1,
                    sectionIndex: this._cellData ? this._cellData.currentNCellIndex : -1,
                    title: this._cellData ? this._cellData.currentVideoTitle : "",
                    sectionKey: this._currentSectionKey(),
                    linkCatalog: Number(this._linkCatalogSize) || 0
                },
                logs: this._logLines.slice(-8).map(function (line) {
                    return line.level + ":" + line.text;
                }),
                positions: Object.keys(this._positions || {})
            };
            [
                "#coursetree", ".coursetree", "[id*=coursetree]", "[class*=coursetree]",
                ".posCatalog_select", ".posCatalog_active", "[class*=posCatalog]",
                "#prevNextFocusNext", ".prev_white", "iframe", "video"
            ].forEach(function (selector) {
                info.dom.counts[selector] = safeValue(function () {
                    return DOC.querySelectorAll(selector).length;
                }, -1);
            });
            if (video) {
                var lock = video.__xxtRateLock;
                var nativeRate = null;
                if (lock && lock.props && lock.props.playbackRate && lock.props.playbackRate.get) {
                    nativeRate = safeValue(function () {
                        return lock.props.playbackRate.get.call(video);
                    }, null);
                }
                info.video = {
                    isCurrent: video === this._videoEl,
                    src: String(safeValue(function () { return video.currentSrc || video.src || ""; }, "")).slice(0, 200),
                    currentTime: safeValue(function () { return Number(video.currentTime); }, 0) || 0,
                    duration: safeValue(function () { return Number(video.duration); }, 0) || 0,
                    rateReported: safeValue(function () { return video.playbackRate; }, null),
                    rateNative: nativeRate,
                    paused: Boolean(video.paused),
                    muted: Boolean(video.muted),
                    ended: Boolean(video.ended),
                    readyState: safeValue(function () { return video.readyState; }, -1),
                    lock: lock ? { rate: lock.rate, blocked: lock.blocked } : null
                };
            }
            void app;
            scanFrames(DOC, 0, "", info.frames);
            return info;
        },

        _writeDiagnostics: function (reason) {
            if (!this.configs.diag) return;
            var info = null;
            try {
                info = this._collectDiagnostics(reason);
                writeJson(DIAG_KEY, info);
            } catch (error) {
                /* 诊断写入失败不影响播放 */
            }
            if (!info || !this.configs.diagHud) return;
            try {
                var brief = {
                    r: info.reason,
                    v: info.version,
                    href: String(info.href || "").slice(0, 240),
                    tree: info.dom.treeFound,
                    counts: info.dom.counts,
                    cat: info.dom.catalogClasses,
                    outline: info.dom.outline,
                    cells: info.cells,
                    video: info.video,
                    frames: info.frames
                };
                els.diag.textContent = "DIAG " + JSON.stringify(brief);
                if (els.panel) els.panel.setAttribute("data-diag", "1");
            } catch (error) {
                /* HUD 诊断渲染失败不影响播放 */
            }
        },

        /* ---------------- 播放控制 ---------------- */

        _applyPlaybackSettings: function (video) {
            if (!video) return;
            if (this.configs.muteVideo) {
                try {
                    video.muted = true;
                    video.defaultMuted = true;
                    video.volume = 0;
                } catch (error) {
                    /* 忽略 */
                }
            }
            var rate = Number(this.configs.playbackRate);
            if (rate > 0) {
                try {
                    this._lockPlaybackRate(video, rate);
                } catch (error) {
                    /* 部分浏览器限制倍速 */
                }
            }
        },

        /* 向上查找某个属性在原型链上的描述符（用来拿到原生 playbackRate 的 setter） */
        _propertyDescriptor: function (target, prop) {
            var current = target;
            while (current) {
                var desc = Object.getOwnPropertyDescriptor(current, prop);
                if (desc) {
                    return desc;
                }
                current = Object.getPrototypeOf(current);
            }
            return null;
        },

        /*
         * 学习通新版播放器会在 ratechange / timeupdate 时把倍速强制改回 1 倍，
         * 只在外部每帧去赋值是改不过来的（会和播放器来回打架，实际仍是 1 倍速）。
         * 这里在 <video> 实例上定义自己的 playbackRate/defaultPlaybackRate，
         * 外部写入直接忽略，只有本脚本内部通过原生 setter 才真正改到底层媒体元素。
         */
        _lockPlaybackRate: function (video, rate) {
            if (!video || !(rate > 0)) return;
            var self = this;
            var state = video.__xxtRateLock;
            if (!state) {
                state = {
                    rate: Number(rate),
                    applying: false,
                    blocked: 0,
                    props: {
                        playbackRate: this._propertyDescriptor(video, "playbackRate"),
                        defaultPlaybackRate: this._propertyDescriptor(video, "defaultPlaybackRate")
                    }
                };
                var install = function (prop) {
                    var desc = state.props[prop];
                    if (!desc || !desc.get || !desc.set) return;
                    try {
                        Object.defineProperty(video, prop, {
                            configurable: true,
                            enumerable: false,
                            get: function () {
                                return state.rate;
                            },
                            set: function (value) {
                                if (state.applying) {
                                    state.rate = Number(value);
                                    return;
                                }
                                // 播放器想把倍速改回去：丢弃，并记一次日志，方便确认拦截生效
                                state.blocked += 1;
                                if (!state.warned) {
                                    state.warned = true;
                                    try {
                                        self._note("播放器尝试把倍速改回 " + value + " 倍，已拦截", "warn");
                                    } catch (error) {
                                        /* 忽略 */
                                    }
                                }
                            }
                        });
                    } catch (error) {
                        /* 某些浏览器禁止重定义，退化为普通赋值 */
                    }
                };
                install("playbackRate");
                install("defaultPlaybackRate");
                video.__xxtRateLock = state;
            }
            state.rate = Number(rate);
            state.applying = true;
            try {
                var props = ["playbackRate", "defaultPlaybackRate"];
                for (var i = 0; i < props.length; i++) {
                    var desc = state.props[props[i]];
                    if (desc && desc.set) {
                        desc.set.call(video, state.rate);
                    }
                }
            } catch (error) {
                try {
                    video.playbackRate = state.rate;
                } catch (ignored) {
                    /* 忽略 */
                }
            }
            state.applying = false;
        },

        play: function () {
            if (this._destroyed) return;
            try {
                this._initCellData();
                if (this._isChapterTest()) {
                    this._setStatus("检测到章节测验");
                    this._clearCheckInterval();
                    this._advanceChapterTest();
                    return;
                }
                var video = this._getVideoEl();
                if (!video) {
                    if (this._currentStepTitle() === "视频") throw new Error("视频组件尚未加载完成");
                    if (this._advanceLearningStep()) {
                        this._setStatus("切换学习中");
                        var self = this;
                        setTimeout(function () {
                            if (!self._destroyed) self.play();
                        }, Math.max(500, Number(this.configs.retryInterval) || 2000));
                        return;
                    }
                    const retryable = this._handlePlayError(new Error("当前步骤不是视频，且未找到可切换的下一项"));
                    if (!retryable) this._setStatus("等待中");
                    return;
                }
                this._isPlaying = true;
                this._paused = false;
                this._currentRetryCount = 0;
                this._videoEventHandle();
                this._applyPlaybackSettings(video);
                this._applyResumePosition(video);
                this._startVideoMonitoring(video);
                this._setStatus("播放中");
                var promise = video.play();
                if (promise && typeof promise.then === "function") {
                    var self2 = this;
                    promise.then(function () {
                        self2._isPlaying = true;
                        self2._lastProgressAt = Date.now();
                        self2._applyPlaybackSettings(video);
                    }).catch(function (error) {
                        if (error && error.name === "AbortError") return;
                        var retryable = self2._handlePlayError(error);
                        if (!retryable) {
                            self2._isPlaying = false;
                            self2._clearCheckInterval();
                            self2._setStatus("等待手动播放");
                        }
                    });
                }
            } catch (error) {
                this._handlePlayError(error);
            }
        },

        togglePause: function () {
            this._paused = !this._paused;
            var video = this._getVideoEl() || this._videoEl;
            if (!video) {
                this._note(this._paused ? "已暂停自动播放" : "已恢复自动播放", "info");
                this._setStatus(this._paused ? "已暂停" : "播放中");
                return;
            }
            try {
                if (this._paused) {
                    video.pause();
                    this._isPlaying = false;
                    this._setStatus("已暂停");
                } else {
                    this._isPlaying = true;
                    this._applyPlaybackSettings(video);
                    var promise = video.play();
                    if (promise && promise.catch) promise.catch(function () {});
                    this._setStatus("播放中");
                }
            } catch (error) {
                this._note("暂停/继续失败：" + (error && error.message ? error.message : error), "error");
            }
            this._updateHud();
        },

        _startVideoMonitoring: function (video) {
            if (video) this._videoEl = video;
            this._clearCheckInterval();
            if (this._destroyed) return;
            var self = this;
            var interval = Math.max(500, Number(this.configs.videoCheckInterval) || 1000);
            this._checkInterval = setInterval(function () {
                try {
                    self._checkVideoStatus();
                } catch (error) {
                    console.error("[学习通助手] 状态检查异常", error);
                }
            }, interval);
        },

        _clearCheckInterval: function () {
            if (this._checkInterval) {
                clearInterval(this._checkInterval);
                this._checkInterval = null;
            }
        },

        _checkVideoStatus: function () {
            if (this._destroyed) return;
            var video = this._getVideoEl();
            if (video) {
                if (this._eventVideoEl !== video && !this._nextUnitPending) this._videoEventHandle();
                this._savePosition(video);
                if (this._isPlaying && video.ended && !this._nextUnitPending) {
                    this._handleVideoEnded();
                    return;
                }
                if (!video.paused && !video.ended) {
                    this._lastProgressAt = Date.now();
                } else if (this._isPlaying && !this._paused && !this._nextUnitPending &&
                    Date.now() - this._lastProgressAt > Math.max(1000, Number(this.configs.guardNoProgressMs) || 7000)) {
                    this._lastProgressAt = Date.now();
                    this._tryResumePlayback("长时间未前进");
                }
                if (this.configs.muteVideo && !video.muted) {
                    try {
                        video.muted = true;
                        video.volume = 0;
                    } catch (error) {
                        /* 忽略 */
                    }
                }
                var rate = Number(this.configs.playbackRate);
                if (rate > 0 && !video.__xxtRateLock) {
                    try {
                        this._lockPlaybackRate(video, rate);
                    } catch (error) {
                        /* 忽略 */
                    }
                }
            }
            if (this.configs.diag) {
                var now = Date.now();
                if (!this._lastDiagAt || now - this._lastDiagAt > 5000) {
                    this._lastDiagAt = now;
                    this._writeDiagnostics("tick");
                }
            }
            this._updateHud();
        },

        _tryResumePlayback: function (reason) {
            if (this._destroyed || this._paused || this._nextUnitPending) return;
            var video = this._getVideoEl() || this._videoEl;
            if (!video || video.ended) return;
            if (!video.paused) return;
            var now = Date.now();
            var cooldown = Math.max(300, Number(this.configs.guardResumeCooldownMs) || 1500);
            if (now - this._lastResumeAt < cooldown) return;
            this._lastResumeAt = now;
            this._note("自动恢复播放：" + (reason || ""), "warn");
            this._isPlaying = true;
            this._applyPlaybackSettings(video);
            try {
                var promise = video.play();
                if (promise && promise.catch) promise.catch(function () {});
            } catch (error) {
                /* 忽略 */
            }
            this._startVideoMonitoring(video);
        },

        _handlePlayError: function (error, fromEvent) {
            if (this._destroyed) return false;
            if (error && error.name === "AbortError") return false;
            var message = error && error.message ? error.message : String(error || "未知错误");
            this._videoEl = null;
            this._detachVideoEvents();
            var now = Date.now();
            this._chapterAdvanceTimes.push(now);
            this._chapterAdvanceTimes = this._chapterAdvanceTimes.slice(-3);
            var recent = this._chapterAdvanceTimes.filter(function (item) {
                return now - item < 20000;
            }).length;
            this._note("播放异常：" + message, "error");
            if (recent >= 3) {
                this._clearCheckInterval();
                this._isPlaying = false;
                this._setStatus("连续异常，已暂停自动切换");
                return false;
            }
            this._currentRetryCount += 1;
            if (this._currentRetryCount > (Number(this.configs.maxRetries) || 10)) {
                this._clearCheckInterval();
                this._isPlaying = false;
                this._setStatus("重试次数过多，已停止");
                return false;
            }
            this._setStatus("重试中（" + this._currentRetryCount + "）");
            var self = this;
            var interval = Math.max(300, Number(this.configs.retryInterval) || 2000);
            setTimeout(function () {
                if (self._destroyed) return;
                try {
                    self._initCellData();
                    if (self._advanceLearningStep()) {
                        setTimeout(function () {
                            if (!self._destroyed) self.play();
                        }, interval);
                    } else {
                        self.play();
                    }
                } catch (retryError) {
                    /* 下一轮状态检查会继续重试 */
                }
            }, interval);
            return true;
        },

        /* ---------------- 步骤 / 章节切换 ---------------- */

        _currentStepTitle: function () {
            try {
                var titleNode = DOC.getElementsByClassName("prev_title")[0];
                var text = normalizeText(titleNode ? titleNode.textContent : "");
                if (text) return text;
            } catch (error) {
                /* 忽略 */
            }
            var card = null;
            try {
                card = DOC.querySelector('iframe[src*="/knowledge/cards"]');
            } catch (error) {
                card = null;
            }
            if (card) {
                try {
                    var url = new URL(card.getAttribute("src"), PAGE.location.href);
                    var num = url.searchParams.get("num");
                    if (num === "0") return "视频";
                    if (num === "1") return "章节测验";
                } catch (error) {
                    /* 忽略 */
                }
            }
            return "";
        },

        _isChapterTest: function () {
            return this._currentStepTitle().indexOf("章节测验") >= 0;
        },

        _advanceChapterTest: function () {
            if (this._isPlaying) this._clearCheckInterval();
            if (!this._isChapterTest()) {
                this._note("当前步骤不是章节测验，结束答题流程", "warn");
                return;
            }
            this._setStatus("章节测验：请手动完成");
            this._note("检测到章节测验，请手动完成后脚本会自动继续", "warn");
            try {
                if (typeof PAGE.alert === "function") {
                    PAGE.alert("检测到章节测验，请在页面中手动完成。\n完成后脚本会自动继续播放。");
                }
            } catch (error) {
                /* 忽略 */
            }
        },

        _findNextButton: function () {
            var nodes = [];
            try {
                nodes = Array.prototype.slice.call(DOC.querySelectorAll("#prevNextFocusNext, #right1, .nextChapter"));
            } catch (error) {
                nodes = [];
            }
            for (var i = 0; i < nodes.length; i++) {
                if (isVisible(nodes[i])) return nodes[i];
            }
            return null;
        },

        _advanceLearningStep: function () {
            var currentStepTitle = this._currentStepTitle();
            var current = DOC.querySelector(".posCatalog_active");
            var tabs = [];
            try {
                tabs = Array.prototype.filter.call(DOC.querySelectorAll(".prev_white"), isVisible);
            } catch (error) {
                tabs = [];
            }
            var videoTab = null;
            for (var i = 0; i < tabs.length; i++) {
                var text = normalizeText(tabs[i].textContent);
                if (text === "2视频" || text === "视频") {
                    videoTab = tabs[i];
                    break;
                }
            }
            if (videoTab) {
                if (currentStepTitle === "视频") {
                    if (videoTab === current) return false;
                    this._chapterAdvanceTimes = [];
                } else {
                    var last = this._chapterAdvanceTimes[this._chapterAdvanceTimes.length - 1] || 0;
                    if (Date.now() - last < 5000) {
                        this._setStatus("操作过于频繁，等待中");
                        return true;
                    }
                }
                dispatchClick(videoTab);
                return true;
            }
            if (this._isChapterTest()) {
                var nextInQuiz = this._findNextButton();
                if (nextInQuiz) {
                    dispatchClick(nextInQuiz);
                    this._chapterAdvanceTimes = [];
                    return true;
                }
            }
            var nextButton = this._findNextButton();
            if (nextButton) {
                var lastClick = this._chapterAdvanceTimes[this._chapterAdvanceTimes.length - 1] || 0;
                if (Date.now() - lastClick < 5000) {
                    this._setStatus("操作过于频繁，等待中");
                    return true;
                }
                dispatchClick(nextButton);
                this._chapterAdvanceTimes = [];
                return true;
            }
            return false;
        },

        _bindStepNavigation: function () {
            if (this._stepNavHandler) return;
            var self = this;
            this._stepNavHandler = function (event) {
                var target = event.target;
                var tab = target && target.closest ? target.closest(".prev_white") : null;
                if (!tab) return;
                var text = normalizeText(tab.textContent);
                if (text === "2视频" || text === "视频" || text.indexOf("测验") >= 0) {
                    self._chapterAdvanceTimes = [];
                    self._setStatus("切换学习步骤");
                }
            };
            DOC.addEventListener("click", this._stepNavHandler, true);
        },

        _unbindStepNavigation: function () {
            if (this._stepNavHandler) {
                DOC.removeEventListener("click", this._stepNavHandler, true);
                this._stepNavHandler = null;
            }
        },

        nextUnit: function (markCompleted) {
            if (this._destroyed) return;
            if (this._nextUnitPending) {
                this._note("正在切换中，忽略重复的下一节请求", "warn");
                return;
            }
            this._initCellData();
            if (this._isChapterTest()) {
                if (markCompleted !== false) this._markSectionCompleted();
                this._setStatus("章节测验");
                this._advanceChapterTest();
                return;
            }
            this._nextUnitPending = true;
            this._isPlaying = false;
            var videoToSave = this._videoEl;
            this._clearCheckInterval();
            this._detachVideoEvents();
            this._clearAfterEndedTimer();
            this._savePosition(videoToSave, true);
            this._videoEl = null;
            if (markCompleted !== false) this._markSectionCompleted();
            try {
                var stepped = this._advanceLearningStep();
                if (!stepped) throw new Error("无法进入下一节");
                this._note("正在切换到下一节", "info");
                this._setStatus("切换下一节");
            } catch (error) {
                this._nextUnitPending = false;
                this._note("切换下一节失败：" + (error && error.message ? error.message : error), "error");
                throw error;
            }
            this._currentRetryCount = 0;
            var self = this;
            if (this._nextUnitTimer) clearTimeout(this._nextUnitTimer);
            this._nextUnitTimer = setTimeout(function () {
                self._nextUnitTimer = null;
                self._nextUnitPending = false;
                if (self._destroyed) return;
                self.play();
            }, Math.max(300, Number(this.configs.retryInterval) || 2000));
        },

        playCurrentIndex: function (nCell) {
            if (!nCell) {
                this._note("找不到对应的目录节点", "warn");
                return;
            }
            this._nextUnitPending = true;
            this._isPlaying = false;
            this._clearCheckInterval();
            this._detachVideoEvents();
            this._clearAfterEndedTimer();
            this._videoEl = null;
            this._videoCache = null;
            this._videoCacheTs = 0;
            this._sectionVideoIndex = 0;
            this._sectionVideoCount = 0;
            this._playedSignatures = new Set();
            dispatchClick(nCell);
            var self = this;
            setTimeout(function () {
                self._nextUnitPending = false;
                if (self._destroyed) return;
                self._initCellData();
                self.play();
            }, 2500);
        },

        /* ---------------- 页面保活 ---------------- */

        _bindPageGuards: function () {
            if (this._pageGuardHandlers) return;
            var self = this;
            var onVisible = function () {
                if (DOC.visibilityState === "visible") self._tryResumePlayback("页面重新可见");
            };
            var onFocus = function () {
                self._tryResumePlayback("窗口重新获得焦点");
            };
            DOC.addEventListener("visibilitychange", onVisible);
            PAGE.addEventListener("focus", onFocus);
            this._pageGuardHandlers = { onVisible: onVisible, onFocus: onFocus };
            if (this.configs.keepAlive) {
                this._guardTimer = setInterval(function () {
                    if (self._destroyed || !self.configs.keepAlive) return;
                    if (!self._isPlaying || self._paused || self._nextUnitPending) return;
                    var video = self._videoEl;
                    if (video && video.paused && !video.ended) self._tryResumePlayback("心跳检测");
                }, 5000);
            }
        },

        _unbindPageGuards: function () {
            if (!this._pageGuardHandlers) return;
            DOC.removeEventListener("visibilitychange", this._pageGuardHandlers.onVisible);
            PAGE.removeEventListener("focus", this._pageGuardHandlers.onFocus);
            this._pageGuardHandlers = null;
        }
    };

    app.destroy = (function (originalDestroy) {
        return function () {
            app._unbindPageGuards();
            return originalDestroy.call(app);
        };
    })(app.destroy);

    return app;
}
