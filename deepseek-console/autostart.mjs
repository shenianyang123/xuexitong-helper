/**
 * 开机自启管理（仅 Windows）。
 *
 * 原理：在「启动」文件夹写一个隐藏窗口的 VBScript，它负责在登录后
 * 以 `--background` 模式拉起 start-local-service.cmd，日志追加到 service.log。
 *
 * 用法：
 *   node autostart.mjs install     安装开机自启（可重复执行，覆盖旧文件）
 *   node autostart.mjs uninstall   取消开机自启
 *   node autostart.mjs status      查看当前状态
 */

import { writeFileSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const DIR = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '');
const STARTUP_DIR = join(
    process.env.APPDATA || '',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup'
);
const SHORTCUT_NAME = 'XuexitongDeepSeekService.vbs';
const SHORTCUT_PATH = join(STARTUP_DIR, SHORTCUT_NAME);
const CMD_PATH = join(DIR, 'start-local-service.cmd');

/** 生成启动脚本内容（UTF-16LE 才能正确保存中文路径）。 */
export function buildShortcutScript() {
    const lines = [
        "' 由 install-autostart.cmd 自动生成：登录后静默启动学习通 DeepSeek 本地服务。",
        "' 取消自启：运行 uninstall-autostart.cmd（或删除本文件）。",
        'Set sh = CreateObject("WScript.Shell")',
        `sh.CurrentDirectory = "${DIR}"`,
        // 通过 cmd.exe 启动，而不是直接 ShellExecute 这个 .cmd：
        // 直接运行 .cmd 会弹出「无法验证发布者 / 打开文件 - 安全警告」对话框
        // （隐藏窗口模式下这个对话框看不见，会让自启看起来像失效）。
        `sh.Run "cmd.exe /c """"${CMD_PATH}"" --background""", 0, False`
    ];
    return `${lines.join('\r\n')}\r\n`;
}

function writeUtf16(path, text) {
    const body = Buffer.from(text, 'utf16le');
    writeFileSync(path, Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
}

function ensureStartupDir() {
    if (!process.env.APPDATA) throw new Error('未找到 APPDATA 环境变量，无法定位「启动」文件夹');
    if (!existsSync(STARTUP_DIR)) throw new Error(`「启动」文件夹不存在：${STARTUP_DIR}`);
}

export function install() {
    ensureStartupDir();
    if (!existsSync(CMD_PATH)) throw new Error(`文件不存在：${CMD_PATH}`);
    writeUtf16(SHORTCUT_PATH, buildShortcutScript());
    console.log('已安装开机自启：');
    console.log(`  ${SHORTCUT_PATH}`);
    console.log('');
    console.log('登录 Windows 后会自动在后台启动本地服务（无黑窗口），日志写入：');
    console.log(`  ${join(DIR, 'service.log')}`);
    return SHORTCUT_PATH;
}

export function uninstall() {
    if (!existsSync(SHORTCUT_PATH)) {
        console.log('没有找到开机自启项，无需取消：');
        console.log(`  ${SHORTCUT_PATH}`);
        return false;
    }
    unlinkSync(SHORTCUT_PATH);
    console.log('已取消开机自启：');
    console.log(`  ${SHORTCUT_PATH}`);
    return true;
}

export function status() {
    const installed = existsSync(SHORTCUT_PATH);
    console.log(`开机自启：${installed ? '已安装' : '未安装'}`);
    console.log(`  启动项：${SHORTCUT_PATH}`);
    if (installed) {
        console.log(`  修改时间：${statSync(SHORTCUT_PATH).mtime.toLocaleString()}`);
    }
    const log = join(DIR, 'service.log');
    console.log(`  日志文件：${log}${existsSync(log) ? '（存在）' : '（尚未生成）'}`);
    return installed;
}

/** 立即后台启动一次（不等待）。 */
function runNow() {
    if (!existsSync(SHORTCUT_PATH)) throw new Error('请先安装开机自启');
    const child = spawn('wscript.exe', ['//nologo', SHORTCUT_PATH], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
    });
    child.unref();
    return child.pid;
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isMain) {
    const action = (process.argv[2] || '').trim().toLowerCase();
    try {
        if (action === 'install') {
            install();
            const pid = runNow();
            console.log(`已在后台启动一次（wscript pid=${pid}），日志见 service.log。`);
        } else if (action === 'uninstall') {
            uninstall();
        } else if (action === 'status') {
            status();
        } else {
            console.log('用法：node autostart.mjs install|uninstall|status');
        }
    } catch (error) {
        console.error(`失败：${error.message}`);
        process.exitCode = 1;
    }
}
