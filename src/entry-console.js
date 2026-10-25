/* 入口：Edge 控制台版 + DeepSeek 章节测验自动作答（V4）
 * 构建产物：deepseek-console/xuexitong-console.js
 *
 * 约束：本文件整体必须是单个具名函数 xuexitongMain，且不依赖外部变量；
 * 整页跳转后由辅助窗口通过 xuexitongMain.toString() 重新注入。
 */

(function xuexitongMain() {
    "use strict";

    var PAGE = window;
    var APP_KEY = "__xuexitongConsoleDeepSeek";
    var BOOT_TIMER_KEY = "__xuexitongConsoleDeepSeekBootTimer";
    var LOCAL_URL = "http://127.0.0.1:37841";
    var LOCAL_TOKEN = "__LOCAL_TOKEN__";
    var startedByKeeper = PAGE.__xuexitongAutoInjected === true;
    delete PAGE.__xuexitongAutoInjected;

    if (!/^https:\/\/([a-z0-9-]+\.)*chaoxing\.com$/i.test(location.origin) ||
        location.pathname.indexOf("/mycourse/studentstudy") < 0) {
        console.error("请在学习通课程播放页的控制台执行本脚本");
        return;
    }
    if (!LOCAL_TOKEN || LOCAL_TOKEN === "__LOCAL_TOKEN__") {
        console.error(
            "尚未写入本地服务令牌：\n" +
            "1) 运行 deepseek-console/start-local-service.cmd 启动本地服务；\n" +
            "2) 复制 deepseek-console/xuexitong-console.ready.js 的全部内容到本页控制台执行。"
        );
        return;
    }

    var previousApp = PAGE[APP_KEY];
    if (previousApp && typeof previousApp.destroy === "function") previousApp.destroy();
    if (PAGE.__xuexitongPlayerV3 && typeof PAGE.__xuexitongPlayerV3.destroy === "function") {
        PAGE.__xuexitongPlayerV3.destroy();
    }
    if (PAGE.__xuexitongPlayerV4DeepSeek && typeof PAGE.__xuexitongPlayerV4DeepSeek.destroy === "function") {
        PAGE.__xuexitongPlayerV4DeepSeek.destroy();
    }
    if (PAGE[BOOT_TIMER_KEY]) {
        clearInterval(PAGE[BOOT_TIMER_KEY]);
        PAGE[BOOT_TIMER_KEY] = null;
    }

    /* @@INCLUDE:player-core@@ */

    /* @@INCLUDE:quiz-automation@@ */

    if (!startedByKeeper) installNavigationKeeper();

    /* 开机后「本地服务」往往比浏览器晚几秒起来。旧版只请求一次 /health，
     * 失败就彻底不启动（页面看起来像插件没装），所以这里改成每 2 秒重试，
     * 最多 60 秒；真的连不上再显示一个红色提示条，而不是静默什么都不做。 */
    var HEALTH_RETRY_MS = 2000;
    var HEALTH_MAX_ATTEMPTS = 30;
    var healthAttempt = 0;
    var healthBadge = null;

    function removeHealthBadge() {
        if (healthBadge && healthBadge.parentNode) healthBadge.parentNode.removeChild(healthBadge);
        healthBadge = null;
    }

    function showHealthBadge(lastError) {
        try {
            if (healthBadge) return;
            healthBadge = PAGE.document.createElement("div");
            healthBadge.id = "xuexitong-helper-service-badge";
            healthBadge.style.cssText = [
                "position:fixed", "left:12px", "bottom:12px", "z-index:2147483600",
                "max-width:420px", "padding:10px 12px", "border-radius:8px",
                "background:#fff3cd", "border:1px solid #f0ad4e", "color:#7a4b00",
                "font:13px/1.5 sans-serif", "box-shadow:0 2px 8px rgba(0,0,0,.2)",
                "white-space:pre-line"
            ].join(";");
            healthBadge.textContent =
                "学习通助手：本地服务没有运行，脚本已暂停。\n" +
                "请双击 deepseek-console\\install-autostart.cmd（或 start-local-service.cmd --background），" +
                "然后刷新本页。\n" +
                "（" + String((lastError && lastError.message) || lastError || "") + "）";
            (PAGE.document.body || PAGE.document.documentElement).appendChild(healthBadge);
        } catch (error) {
            /* 提示条失败不影响主流程 */
        }
    }

    function checkHealth() {
        healthAttempt += 1;
        var healthSignal = undefined;
        try {
            if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
                healthSignal = AbortSignal.timeout(5000);
            }
        } catch (error) {
            healthSignal = undefined;
        }
        fetch(LOCAL_URL + "/health", {
            headers: { "X-Xuexitong-Token": LOCAL_TOKEN },
            signal: healthSignal
        }).then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            removeHealthBadge();
            console.log("DeepSeek 本地服务已连接");
            waitForCoursePage();
        }).catch(function (error) {
            if (healthAttempt >= HEALTH_MAX_ATTEMPTS) {
                console.error("DeepSeek 本地服务不可用，请先启动服务并检查 Edge 的本地网络访问权限:", error);
                showHealthBadge(error);
                return;
            }
            console.warn("本地服务暂未就绪，2 秒后重试（" + healthAttempt + "/" + HEALTH_MAX_ATTEMPTS + "）");
            setTimeout(checkHealth, HEALTH_RETRY_MS);
        });
    }

    checkHealth();

    function installNavigationKeeper() {
        var keeper;
        try {
            keeper = PAGE.open("", "xuexitongConsoleKeeper", "width=360,height=150");
            if (!keeper) throw new Error("浏览器阻止了辅助窗口");
            keeper.document.title = "学习通自动任务辅助窗口";
            keeper.document.body.innerHTML =
                '<p style="font:16px sans-serif;padding:12px">学习通自动任务正在运行。' +
                "请保持此窗口打开；课程页整页跳转后，它会重新启动脚本。</p>";
            keeper.__xuexitongSource = "(" + xuexitongMain.toString() + ")();";
            keeper.__xuexitongLastUrl = location.href;
            keeper.__xuexitongLastInjectionAt = Date.now();
            if (!keeper.__xuexitongKeeperTimer) {
                keeper.eval("window.__xuexitongKeeperTimer = setInterval(function () {\n" +
                    "    try {\n" +
                    "        var page = window.opener;\n" +
                    "        if (!page || page.closed) { clearInterval(window.__xuexitongKeeperTimer); window.close(); return; }\n" +
                    "        if (!/^https:\\/\\/([a-z0-9-]+\\.)*chaoxing\\.com(\\/[a-z0-9-]+)*\\/mycourse\\/studentstudy/i.test(page.location.href)) return;\n" +
                    "        if (page.location.href !== window.__xuexitongLastUrl) {\n" +
                    "            window.__xuexitongLastUrl = page.location.href;\n" +
                    "            window.__xuexitongLastInjectionAt = Date.now() - 30000;\n" +
                    "        }\n" +
                    "        if (page.document.readyState !== 'complete' || !page.document.querySelector('#coursetree, .posCatalog_select, a[href*=getTeacherAjax]')) return;\n" +
                    "        if (page.__xuexitongConsoleDeepSeek || page.__xuexitongConsoleDeepSeekBootTimer) return;\n" +
                    "        if (Date.now() - window.__xuexitongLastInjectionAt < 30000) return;\n" +
                    "        window.__xuexitongLastInjectionAt = Date.now();\n" +
                    "        page.__xuexitongAutoInjected = true;\n" +
                    "        page.eval(window.__xuexitongSource);\n" +
                    "    } catch (error) {\n" +
                    "        if (Date.now() - (window.__xuexitongLastErrorAt || 0) > 30000) {\n" +
                    "            window.__xuexitongLastErrorAt = Date.now();\n" +
                    "            window.document.body.textContent = '整页跳转后的自动恢复遇到错误：' + error.message;\n" +
                    "            console.warn('学习通整页跳转后的自动恢复暂不可用:', error);\n" +
                    "        }\n" +
                    "    }\n" +
                    "}, 1000);");
            }
            keeper.blur();
            PAGE.focus();
            console.log("整页跳转辅助窗口已启动；请保持它打开");
        } catch (error) {
            console.warn(
                "整页跳转后无法自动重新启动脚本；请允许此站点打开弹出窗口，或在新页面重新粘贴脚本。",
                error
            );
        }
    }

    function hasCourseCatalog() {
        try {
            return Boolean(document.querySelector("#coursetree")) ||
                Boolean(document.querySelector(".posCatalog_select")) ||
                Boolean(document.querySelector('a[href*="getTeacherAjax"]'));
        } catch (error) {
            return false;
        }
    }

    function waitForCoursePage() {
        var attempts = 0;
        var maxAttempts = 20;
        PAGE[BOOT_TIMER_KEY] = setInterval(function () {
            if (hasCourseCatalog()) {
                clearInterval(PAGE[BOOT_TIMER_KEY]);
                PAGE[BOOT_TIMER_KEY] = null;
                initializePlayer();
                return;
            }
            attempts += 1;
            if (attempts >= maxAttempts) {
                clearInterval(PAGE[BOOT_TIMER_KEY]);
                PAGE[BOOT_TIMER_KEY] = null;
                console.error(
                    "脚本启动超时：未检测到课程目录。请确认当前处于课程播放页。"
                );
            }
        }, 1000);
    }

    function initializePlayer() {
        var app = createPlayerApp(PAGE, {
            productName: "学习通视频与章节测验助手 V4",
            playbackRate: 1,
            muteVideo: true,
            autoResume: true
        });
        attachQuizAutomation(app);
        PAGE.app = app;
        PAGE[APP_KEY] = app;
        app.run();
        app._bindPageGuards();
        console.log("%c学习通视频与章节测验助手 V4 已启动", "color:#1f6feb;font-weight:bold");
        return app;
    }
})();
