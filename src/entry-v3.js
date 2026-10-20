/* 入口：浏览器控制台直接执行版（V3）
 * 构建产物：v3_optimized.js / v3_optimized.user.js
 */

(function () {
    "use strict";

    var PAGE = window;
    var APP_KEY = "__xuexitongPlayerV3";
    var BOOT_TIMER_KEY = "__xuexitongPlayerV3BootTimer";

    var previousApp = PAGE[APP_KEY];
    if (previousApp && typeof previousApp.destroy === "function") {
        try {
            previousApp.destroy();
        } catch (error) {
            console.warn("[学习通助手] 清理旧实例失败", error);
        }
    }
    if (PAGE[BOOT_TIMER_KEY]) {
        clearInterval(PAGE[BOOT_TIMER_KEY]);
        PAGE[BOOT_TIMER_KEY] = null;
    }

    /* @@INCLUDE:player-core@@ */

    function initializePlayer() {
        var app = createPlayerApp(PAGE, {
            productName: "学习通自动刷课脚本 V3",
            playbackRate: 1.5,
            muteVideo: false,
            autoResume: true
        });
        PAGE.app = app;
        PAGE[APP_KEY] = app;
        app.run();
        app._bindPageGuards();
        console.log("%c学习通自动刷课脚本 V3 已启动", "color:#1f6feb;font-weight:bold");
        return app;
    }

    function waitForCoursePage() {
        var attempts = 0;
        var maxAttempts = 20;
        PAGE[BOOT_TIMER_KEY] = setInterval(function () {
            if (document.querySelector("#coursetree")) {
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
                    "%c脚本启动超时：未检测到课程目录（#coursetree）。请确认当前处于课程播放页。",
                    "color:#F44336;font-weight:bold"
                );
            }
        }, 1000);
    }

    if (document.querySelector("#coursetree")) {
        initializePlayer();
    } else {
        waitForCoursePage();
    }
})();
