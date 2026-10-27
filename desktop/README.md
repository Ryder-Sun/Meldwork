# Meldwork 桌面客户端

Meldwork 是完全本地运行的 Electron 客户端。它直接加载仓库中的桌面前端，在 Electron
主进程中检测和调用本机 Agent CLI，不需要登录、JWT、远端平台、Docker 或云端服务。

本地群聊、消息、群组配置和 CLI 会话引用保存在 Electron 用户数据目录。渲染进程只通过
`window.meldworkDesktop` 调用经过约束的 preload API，不会获得可执行文件路径、Provider
API Key 或任意 Shell 执行能力。

支持检测和调用以下本机 Agent CLI：

- Codex
- Hermes
- OpenClaw
- WorkBuddy
- Zcode
- Pi Agent
- Kimi Code
- MiMo Code
- Claude Code
- Gemini CLI
- OpenCode
- Qwen Code
- OpenCodeReview

Agent 管理面板提供经过白名单约束的安装入口。安装命令和下载地址由主进程固定，不会根据页面
输入执行任意命令。内置 Agent 通过各自支持的原生权限模式或 Meldwork 托管工具策略执行；无法
满足当前权限契约的 Agent 会安全失败。群聊级工作目录写入默认关闭，只有用户明确授权后才会
切换为写入模式。Kimi 在只读对话中通过 Agent Client Protocol 的 `plan` 模式运行；用户明确
开启写入权限后，才切换到 Kimi 原生的 `stream-json --prompt` 模式。

## 首次启动与本地 Agent 检测

V1.0.7 GitHub 预发布使用 ad-hoc 临时签名，不使用 Apple Developer ID，也不提交 Apple 公证。
如果 macOS 首次启动时拦截候选应用，请打开
“系统设置 → 隐私与安全性”，找到 Meldwork 的拦截提示，点击“仍要打开 / Open Anyway”，
再确认启动。

首次启动会显示三页引导轮播，依次介绍本地 Agent 检测、多 Agent 协作、Skill 与文件上下文。
客户端在引导打开时执行唯一一次启动刷新；检测任务真正结束前“开始使用”按钮保持禁用，不会
用固定计时器伪装完成。检测成功或失败后才释放按钮。完成或关闭引导后会在渲染层本地记录状态，
后续启动直接进入工作台；Agent 仍可在管理面板中重新检测。

## 并发协作 Harness V4

群聊中选择多个 Agent 后，“并发回复”会在任何 Agent 获取调度资源前冻结同一份任务快照，让全部已选 Agent 独立生成，并在批次屏障后按稳定顺序提交。

Auto Discussion 会依次进入独立提案、交叉质询与职责协商、分工执行、单写者整合和独立复核。职责图由 Agent 协商产生，Harness 只负责验证全员同意的同一份计划、依赖、权限、回执、恢复和提交边界，不在模型之外私下分配工作。参与者仍由用户选定；从更大候选池自动选人组队不属于当前版本。

## `@` Skill 引用

在消息输入框输入 `@` 或点击 `@` 按钮，可以选择当前目标 Agent 本机已发现的 Skill。列表只
返回清洗后的 Agent、命名空间、slug 和显示名称，不返回 Skill 文件路径或内容。一次消息最多
选择 4 个 Skill；主进程会在发送前按目标 Agent 重新扫描并验证选择，跨 Agent 冒用、过期条目
或前端构造的任意路径都会被拒绝。Hermes 使用原生 `--skills` 参数预加载已验证 Skill；其他
Agent 只会收到属于自己的 Skill 坐标提示，不会收到其他目标的选择。

## 文件与多模态附件

消息输入框支持系统文件选择器、剪贴板图片以及把文件拖入输入区。当前接受经过 MIME、扩展名和
文件签名交叉校验的 PNG、JPEG、音视频、PDF、文本、Markdown、常见代码与配置文件、Office
文档和常见压缩容器；一条消息最多 4 个附件，各格式使用独立大小上限。附件会复制到 Electron
用户数据目录下的私有存储，工作区消息只保存 `id`、文件名、MIME 类型和大小；渲染层不能读取
附件路径，只能通过窄 IPC 请求预览或使用系统默认应用打开文件。

Agent 原生支持的图片会按其数量限制直接传递。其他文件，或超过某个 Agent 原生媒体能力的附件，
会在运行期间暂存为工作区内的只读输入文件，并在运行结束后清理；提示词明确要求只读取、不得执行
附件。未发送附件、删除会话后的无引用附件和异常导入残留由主进程回收。

## Provider 配置

Agent 使用各自本机的原生鉴权、Provider 和默认模型配置。Meldwork 不要求统一 Provider，
也不会将一个 Agent 的密钥注入其他 Agent。WorkBuddy 桌面账号的加密登录不能直接供独立
CLI 解锁；可在 Meldwork 中选择桌面配置里已有且已配置鉴权的模型。
Meldwork 仅保存模型标识，运行时由主进程读取原生配置，不向渲染层返回密钥。
Zcode 沿用默认配置；若其默认 Provider 缺少 API Key，需要先修复本机原生配置。

## 本地 CLI 支持矩阵

| Agent | 检测命令 | macOS 安装 | Windows 安装 | 用户 Provider |
| --- | --- | --- | --- | --- |
| Codex | `codex` | npm：`@openai/codex@latest` | npm：`@openai/codex@latest` | 不注入；沿用 Codex 本机配置 |
| Hermes | `hermes` | 官方 `install.sh` | 官方 `install.ps1` | 沿用本机配置 |
| OpenClaw | `openclaw` | npm：`openclaw@latest` | npm：`openclaw@latest` | 沿用本机配置 |
| WorkBuddy | `codebuddy` | npm：`@tencent-ai/codebuddy-code@2.115.0` | npm：`@tencent-ai/codebuddy-code@2.115.0` | 可选择桌面已配置模型 |
| Zcode | `zcode` | 官方 CLI 安装 | 官方 CLI 安装 | 沿用默认配置 |
| Pi Agent | `pi` | npm：`@mariozechner/pi-coding-agent` | npm：`@mariozechner/pi-coding-agent` | 沿用本机配置 |
| Kimi Code | `kimi` | 官方 `install.sh` | 官方 `install.ps1` | 不注入；沿用 Kimi 本机配置 |
| MiMo Code | `mimo` | npm：`@mimo-ai/cli@latest` | npm：`@mimo-ai/cli@latest` | 不注入；沿用 MiMo 本机配置，按授权使用 `plan` / `build` 模式 |
| Claude Code | `claude` | npm：`@anthropic-ai/claude-code@latest` | npm：`@anthropic-ai/claude-code@latest` | 不注入；沿用 Claude 本机配置 |
| Gemini CLI | `gemini` | npm：`@google/gemini-cli@latest` | npm：`@google/gemini-cli@latest` | 不注入；沿用 Gemini 本机配置 |
| OpenCode | `opencode` | npm：`opencode-ai@latest` | npm：`opencode-ai@latest` | 不注入；沿用 OpenCode 本机配置 |
| Qwen Code | `qwen` | npm：`@qwen-code/qwen-code@latest` | npm：`@qwen-code/qwen-code@latest` | 沿用本机配置 |
| OpenCodeReview | `ocr` | npm：`@alibaba-group/open-code-review@latest` | npm：`@alibaba-group/open-code-review@latest` | 沿用本机配置 |

macOS 会在当前 `PATH` 之外搜索 Volta、pnpm、fnm、asdf、mise、bun、
`~/.local/bin`、`~/.kimi-code/bin`、`~/.mimocode/bin`、Homebrew 等常见目录。Windows 会额外搜索用户 npm、
WindowsApps、Node.js、WorkBuddy、Chocolatey 和 Scoop 目录，并按 `PATHEXT` 解析命令。

Hermes 和 Kimi 的安装脚本来自固定 HTTPS 白名单地址；客户端不内置脚本副本，因此离线环境
不能使用这两个一键安装入口。当前自动安装面向 macOS 和 Windows，Windows 安装流程仍需在
真实 Windows 设备上做发布前验证。

## 目录结构

- `src/agents/`：Agent 兼容层、路由、运行时、CLI、安装器、连接器
- `src/attachments/`：附件、内容存储、图片尺寸校验
- `src/collaboration/`：对话、上下文包、产物、任务图
- `src/workspace/`：本地工作区与自动调度；自动运行器的通用失败、重试和等待语义位于 `local-workspace-auto-runner-support.cjs`
- `src/runs/`：运行、预算、事件、调度、日志
- `src/knowledge/`：知识库与知识连接器
- `src/skills/`：Skill 目录、快照、信任
- `src/security/`：私有文件与敏感信息脱敏
- `test/`：按同名领域镜像组织测试，`support/` 放测试辅助代码；测试发现与 suite 选择位于 `scripts/test-discovery.cjs`

## 本地开发

```bash
cd desktop
npm install
npm run dev
```

可选环境变量：

- `MELDWORK_CODEX_SANDBOX`：Codex 默认沙箱模式，支持 `read-only` 和
  `workspace-write`；未设置或值不受支持时使用 `read-only`。

## 测试与打包

```bash
npm test
npm run pack
npm run dist
npm run dist:public
```

`pack` 用于生成未打包应用并验证 Electron 产物；`dist` 生成 V1.0.7 GitHub 预发布候选使用的 ad-hoc 签名 DMG 和 ZIP。这些产物不具备 Developer ID 信任链且未公证，不能声称通过 Gatekeeper。

`dist:public` 是未来正式签名公开发行的专用命令：它要求
Developer ID 证书和完整公证凭据，强制代码签名，在签名后校验永久 Bundle ID、Team ID 与
hardened runtime，并调用 Apple 公证；任一条件不满足都会失败。产物输出到 `desktop/dist/`，
其中包含本地前端，不依赖服务器或容器。
