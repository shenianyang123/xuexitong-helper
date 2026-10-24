# 学习通视频与章节测验助手（Edge 控制台版 · DeepSeek）

在 [V3 播放核心](../README.md) 的基础上，增加“章节测验自动作答”：识别测验题目 → 调用 DeepSeek → 自动选择并提交。

- **推荐用法是全自动**：本地服务开机自启（无黑窗口）+ Tampermonkey 油猴脚本自动注入，装好后每次只需打开学习通网页；
- 不想装扩展时也可以手动粘贴（下面是方式 B）；
- API Key **不写入脚本文件**，通过环境变量或 `.env.local` 提供；
- 本地服务只监听 `127.0.0.1:37841`，页面脚本通过短期令牌鉴权。

## 零、先把文件拿到本地

这个版本需要在本机跑 Node.js 服务，所以要下载整个项目（不能只在浏览器里复制一段代码）：

1. 打开仓库页 https://github.com/shenianyang123/xuexitong-helper → 右上角 **Code → Download ZIP**，解压到任意目录（会 git 的话直接 `git clone`）；
2. 本机需要 **Node.js 20+**（`node -v` 能输出版本号即可）；
3. 仓库里**不含** `xuexitong-console.ready.js` / `xuexitong-console.ready.user.js`——它们由下面的服务启动时在你的电脑上生成（内含本机令牌，不应提交到仓库）。

> **ZIP 下载的要注意**：Windows 会给解压出来的文件打上“来自 Internet”标记。不解除的话，双击/自启时会弹「无法验证发布者 / 打开文件 - 安全警告」；开机自启是隐藏窗口运行的，这个框你看不到，会表现为“自启没生效”。在解压后的项目目录里右键 → 在终端中打开 → 执行一次：
>
> ```powershell
> Get-ChildItem -Recurse -File | Unblock-File
> ```

## 一、准备 API Key（只需一次）

任选一种方式，服务启动时按顺序读取：

1. **环境变量**（推荐，长期使用）：

   ```cmd
   setx DEEPSEEK_API_KEY sk-你的Key
   ```

   设置后需要新开一个命令行窗口才生效。

2. **`.env.local` 文件**（放在本目录）：首次启动服务时如果没有检测到 Key，会提示输入，输入完成后自动写入本文件。该文件已被 `.gitignore` 忽略。

3. 不配置则每次启动都提示输入（输入内容不显示）。

可选的环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | — | API Key |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 兼容第三方网关时修改 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 换 `deepseek-reasoner` 会自动关闭 JSON 模式 |
| `DEEPSEEK_MAX_TOKENS` | `8000` | 单次答案输出上限 |
| `DEEPSEEK_TIMEOUT_MS` | `120000` | 单次请求超时 |
| `XUEXITONG_PORT` | `37841` | 本地服务端口（改了会自动写进 `xuexitong-console.ready.js`） |

## 二、启动本地服务

1. 确认构建产物存在：仓库里已自带 `xuexitong-console.js`、`xuexitong-console.user.js`；如果你改过 `src/` 源码，在仓库根目录执行 `node scripts/build.mjs` 重新生成；
2. 双击本目录的 **`start-local-service.cmd`**（Windows 批处理，窗口标题为 `Xuexitong DeepSeek local service`；批处理本身只输出英文提示，中文提示由 Node 打印）；
3. 窗口会显示：API Key 校验结果、模型名、以及**生成的 `xuexitong-console.ready.js` 路径**；
4. 首次使用建议再双击 **`install-autostart.cmd`**：把服务装成开机自启（后台运行、无黑窗口，日志追加到本目录 `service.log`）。装好后**不用再双击 cmd**；卸载用 `uninstall-autostart.cmd`，查状态用 `node autostart.mjs status`；
5. 如果不想装自启：保持黑窗口开着，直到课程刷完。

> 端口被占用（提示 `端口 37841 已被占用`）通常说明服务已经在跑（多半是自启那个），不用重复启动。

服务启动时会发生这些事：

- 读取/输入 API Key，并用免费的 `GET /models` 校验一次（失败只警告，不阻止启动）；
- 生成/复用 `.local-token`（所以重启服务后令牌不变，不需要重新复制脚本）；
- 根据构建产物生成 `xuexitong-console.ready.js` 与 `xuexitong-console.ready.user.js`（写入真实令牌）；
- **不会修改构建产物本身**。

## 三、用起来（二选一）

### 方式 A：全自动（推荐，一次配置，以后零操作）

1. 浏览器安装 **Tampermonkey（篡改猴）** 扩展（Edge 商店 / Chrome 商店都有）；
2. 浏览器地址栏打开 `http://127.0.0.1:37841/xuexitong-console.ready.user.js`（端口被 `XUEXITONG_PORT` 改过就用实际端口）。本地服务会实时生成**带本机令牌**的油猴脚本，Tampermonkey 弹出安装页 → 点「安装」；
3. **关键一步**：打开浏览器「扩展」页 → Tampermonkey 的「详情」→ 打开 **「允许用户脚本」** 开关。新版 Chrome / Edge 是 MV3，**不打开这个开关，油猴脚本会静默不执行**（页面毫无反应，最常见的问题）；
4. 装好后打开/刷新学习通课程播放页，右下角出现悬浮球即自动运行。服务装了开机自启后，以后就只剩“打开网页”这一步。

> 装的是 `xuexitong-console.ready.user.js`（带令牌）、不是仓库里的 `xuexitong-console.user.js`（模板）。令牌变了重新打开那个网址装一次即可。

### 方式 B：手动粘贴（不装扩展）

1. 关掉之前安装的学习通油猴脚本，避免两边同时操作页面；
2. Edge 打开学习通课程播放页（`.../mycourse/studentstudy?...`）；
3. `F12` → Console，粘贴 **`xuexitong-console.ready.js`** 的全文，回车（新版 Edge/Chrome 若提示 `Don't paste code`，先在控制台手动输入 `allow pasting` 回车再粘贴）；
4. 脚本会打开一个小的“学习通自动任务辅助窗口”，请保持打开：它在“下一节”触发整页跳转后自动重新注入脚本；
5. 之后可以关闭开发者工具，返回课程页；**本地服务窗口要保持开着**。

如果看到“尚未写入本地服务令牌”，说明执行的是 `xuexitong-console.js` 而不是 `.ready.js`。

## 四、自动流程

- **视频页**：静音自动播放（V4 默认 `muteVideo: true`），同一小节多段视频自动接力，全部结束后切下一节；
- **测验页**：滚动触发懒加载 → 识别单选/多选/判断题 → 校验题量与页面显示一致 → 一次请求 DeepSeek → 核对答案格式 → 选择选项 → 提交 → 处理二次确认 → 等成绩/完成标记 → 切下一节；
- 如果从已完成的测验页启动，会直接进入下一节；
- 题目文字受防复制处理（替换字/夹字）时，提示词会要求模型先还原句意再作答；
- 页面结构、题量、选项、提交结果不符合预期时**停止并打印原因**，不会提交残缺答案；
- 请求失败会按错误类型区分：401 Key 无效、402 余额不足直接报错；429/5xx/超时/输出截断会自动重试一次（第二次关闭 `response_format` 兼容模式）。

## 五、调试

```javascript
app.inspectQuiz();       // 查看识别到的题目（不提交）
app.progress();          // 已完成小节与续播目标
app.resetProgress();     // 清空进度
app.configs.autoAdvanceNoVideo = true; // 允许跳过无视频小节
```

控制台还会打印发送给 DeepSeek 的题干与选项。**题目图片、题干外的材料不会发送**，遇到图表题或依赖前文的题目请先核对 `app.inspectQuiz()`。

## 六、常见问题

| 现象 | 处理 |
| --- | --- |
| `DeepSeek 本地服务不可用` | 检查本地服务是否在跑（装了自启：看 `service.log`；手动启动：看黑窗口是否还开着）；浏览器提示“允许访问本地网络”时选择允许 |
| 装了油猴脚本但页面上一点反应都没有 | 浏览器「扩展」页 → Tampermonkey「详情」→ 打开 **「允许用户脚本」**（MV3 必须，不开就静默不执行）；再确认 `http://127.0.0.1:37841/health` 能返回 JSON |
| 开机自启没生效 / 弹「无法验证发布者」 | ZIP 文件带“来自 Internet”标记：在项目目录执行 `Get-ChildItem -Recurse -File \| Unblock-File`，再重新双击 `install-autostart.cmd`；然后看 `service.log` 有没有启动记录 |
| `HTTP 401` / `API Key 无效` | 重新设置 `DEEPSEEK_API_KEY`，注意不要带引号或空格 |
| `HTTP 402` / `余额不足` | 到 platform.deepseek.com 充值 |
| `输出达到长度上限` | 调大 `DEEPSEEK_MAX_TOKENS`，或减少一次提交的题目数量 |
| `本地令牌不匹配` | 关闭旧服务窗口，重新启动，复制新的 `xuexitong-console.ready.js` |
| 整页跳转后脚本没恢复 | 允许 `mooc1.chaoxing.com` 打开弹出窗口；或在新页面重新粘贴脚本 |
| 新版播放页（地址里带 `/mooc-ans`）以前能用现在没反应 / 面板「章节」显示「未定位到目录」 | 升到 **3.5.4+**：这个版本支持新版页面的链接式目录（`a[href*="getTeacherAjax"]`），并在入口处放行没有 `#coursetree` 的页面。升级后刷新页面即可 |
| 倍速设了 2x 但视频跑回原速 | 播放器会主动改回倍速，脚本已做锁定（日志会写「播放器尝试把倍速改回 X 倍，已拦截」）；也可用 `?xxtrate=2` 参数强制设一次 |
| 面板显示「章节测验自动作答中」却一直不动（旧版 3.5.5 及更早） | 新版 `/mooc-ans` 测验页的选项是 radio/checkbox，文案只有「对 / 错」，没有 A/B 字母，按字母找选项会识别不到。**3.5.6+** 改为按 `input` 分组识别，并直接点原生 `input` 勾选（日志：「已识别 N 道题，正在请求 DeepSeek…」→「DeepSeek 已给出答案，正在勾选选项」）。升级后刷新页面即可 |
| 出现黄色“已在调试程序中暂停” | 在开发者工具按 `F8` 恢复执行，并检查“遇到异常时暂停”是否开启 |
| `Uncaught SyntaxError: missing )` | 粘贴内容被截断，重新从文件复制（末尾应为 `})();`） |
| 双击 `start-local-service.cmd` 一闪而过，或窗口里报 `'xxx' 不是内部或外部命令` | 早期 ZIP 里的 `.cmd` 换行是 LF，cmd.exe 无法解析（现已改为 CRLF，重新下载最新 ZIP 即可）。临时办法：在 `deepseek-console` 目录里执行 `node deepseek-local.mjs` |

页面自带的 `work-css-tpl.cssx 404`、`highlight.js deprecated`、`JQMIGRATE` 提示与脚本无关。

## 七、隐私与费用

题目和选项会发送到 DeepSeek API，可能产生费用，模型也可能答错。API Key 只保存在你自己的电脑上（环境变量或 `.env.local`），不会进入构建产物、不会提交到仓库。
