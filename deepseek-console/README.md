# 学习通视频与章节测验助手（Edge 控制台版 · DeepSeek）

在 [V3 播放核心](../README.md) 的基础上，增加“章节测验自动作答”：识别测验题目 → 调用 DeepSeek → 自动选择并提交。

- 不需要 Tampermonkey；
- API Key **不写入脚本文件**，通过环境变量或 `.env.local` 提供；
- 本地服务只监听 `127.0.0.1:37841`，页面脚本通过短期令牌鉴权。

## 零、先把文件拿到本地

这个版本需要在本机跑 Node.js 服务，所以要下载整个项目（不能只在浏览器里复制一段代码）：

1. 打开仓库页 https://github.com/shenianyang123/xuexitong-helper → 右上角 **Code → Download ZIP**，解压到任意目录（会 git 的话直接 `git clone`）；
2. 本机需要 **Node.js 20+**（`node -v` 能输出版本号即可）；
3. 仓库里**不含** `xuexitong-console.ready.js`——它由下面的服务启动时在你的电脑上生成（内含本机令牌，不应提交到仓库）。

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

1. 确认构建产物存在：仓库里已自带 `xuexitong-console.js`；如果你改过 `src/` 源码，在仓库根目录执行 `node scripts/build.mjs` 重新生成；
2. 双击本目录的 **`start-local-service.cmd`**（Windows 批处理，标题为「学习通 DeepSeek 本地服务」）；
3. 窗口会显示：API Key 校验结果、模型名、以及**生成的 `xuexitong-console.ready.js` 路径**；
4. **保持这个黑窗口打开**，直到课程刷完。

服务启动时会发生这些事：

- 读取/输入 API Key，并用免费的 `GET /models` 校验一次（失败只警告，不阻止启动）；
- 生成/复用 `.local-token`（所以重启服务后令牌不变，不需要重新复制脚本）；
- 根据构建产物 `xuexitong-console.js` 生成 `xuexitong-console.ready.js`（写入真实令牌）；
- **不会修改 `xuexitong-console.js` 本身**。

## 三、在课程页执行脚本

1. 关掉之前安装的学习通油猴脚本，避免两边同时操作页面；
2. Edge 打开学习通课程播放页（`.../mycourse/studentstudy?...`）；
3. `F12` → Console，粘贴 **`xuexitong-console.ready.js`** 的全文，回车（新版 Edge/Chrome 若提示 `Don't paste code`，先在控制台手动输入 `allow pasting` 回车再粘贴）；
4. 脚本会打开一个小的“学习通自动任务辅助窗口”，请保持打开：它在“下一节”触发整页跳转后自动重新注入脚本；
5. 之后可以关闭开发者工具，返回课程页。

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
| `DeepSeek 本地服务不可用` | 检查黑窗口是否还在运行；浏览器提示“允许访问本地网络”时选择允许 |
| `HTTP 401` / `API Key 无效` | 重新设置 `DEEPSEEK_API_KEY`，注意不要带引号或空格 |
| `HTTP 402` / `余额不足` | 到 platform.deepseek.com 充值 |
| `输出达到长度上限` | 调大 `DEEPSEEK_MAX_TOKENS`，或减少一次提交的题目数量 |
| `本地令牌不匹配` | 关闭旧服务窗口，重新启动，复制新的 `xuexitong-console.ready.js` |
| 整页跳转后脚本没恢复 | 允许 `mooc1.chaoxing.com` 打开弹出窗口；或在新页面重新粘贴脚本 |
| 出现黄色“已在调试程序中暂停” | 在开发者工具按 `F8` 恢复执行，并检查“遇到异常时暂停”是否开启 |
| `Uncaught SyntaxError: missing )` | 粘贴内容被截断，重新从文件复制（末尾应为 `})();`） |

页面自带的 `work-css-tpl.cssx 404`、`highlight.js deprecated`、`JQMIGRATE` 提示与脚本无关。

## 七、隐私与费用

题目和选项会发送到 DeepSeek API，可能产生费用，模型也可能答错。API Key 只保存在你自己的电脑上（环境变量或 `.env.local`），不会进入构建产物、不会提交到仓库。
