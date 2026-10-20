/**
 * 开机自启（autostart.mjs）单元测试。
 *
 * 用假的 APPDATA 指向工作区内的临时目录，避免真的写入系统「启动」文件夹。
 * 必须在设置 process.env.APPDATA 之后再动态 import，因为模块顶层就计算了启动目录。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_APPDATA = join(ROOT, '.tmp-autostart-test');
const STARTUP = join(FAKE_APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');

process.env.APPDATA = FAKE_APPDATA;
mkdirSync(STARTUP, { recursive: true });

const mod = await import(`../deepseek-console/autostart.mjs?test=${Date.now()}`);

after(() => {
    rmSync(FAKE_APPDATA, { recursive: true, force: true });
});

test('启动脚本内容包含 --background 与项目内 cmd 路径，并使用 CRLF', () => {
    const script = mod.buildShortcutScript();
    assert.match(script, /CreateObject\("WScript\.Shell"\)/);
    // 必须通过 cmd.exe 间接启动：直接 ShellExecute 这个 .cmd 会弹
    // 「无法验证发布者 / 打开文件 - 安全警告」，隐藏窗口下看不见，自启像失效。
    assert.match(script, /cmd\.exe \/c """"/);
    assert.match(script, /start-local-service\.cmd"" --background""", 0, False/);
    assert.ok(script.includes('\r\n'), '必须使用 CRLF 换行');
    assert.ok(!/[^\r]\n/.test(script), '不能出现裸 LF');
    assert.ok(script.includes('CurrentDirectory'), '必须设置工作目录');
});

test('install 在启动目录写入 UTF-16LE BOM 脚本，uninstall 可删除', () => {
    const created = mod.install();
    assert.ok(existsSync(created));
    const bytes = readFileSync(created);
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xfe);
    const text = bytes.subarray(2).toString('utf16le');
    assert.match(text, /--background/);
    assert.ok(text.includes('start-local-service.cmd'));

    assert.equal(mod.status(), true);
    assert.equal(mod.uninstall(), true);
    assert.ok(!existsSync(created));
    assert.equal(mod.status(), false);
    assert.equal(mod.uninstall(), false);
});

test('install 可重复执行（覆盖写），不会报错', () => {
    mod.install();
    mod.install();
    assert.ok(existsSync(join(STARTUP, 'XuexitongDeepSeekService.vbs')));
    mod.uninstall();
});
