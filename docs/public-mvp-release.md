# Meldwork V1.0.3 预发布与分发边界

Meldwork-V1.0.3 对应桌面包版本 `0.1.3`，当前验证目标是 Apple silicon macOS。该版本作为 GitHub prerelease 分发，使用 ad-hoc 临时签名，没有 Apple Developer ID 签名，也未提交 Apple 公证。它不能被描述为通过 Gatekeeper 的正式 macOS 发行版；首次启动可能需要在“系统设置 → 隐私与安全性”中选择“仍要打开 / Open Anyway”。

## 当前产品合同

V1.0.3 是一个本地优先的多 Agent Work Cell，由用户选择参与 Agent、工作目录和写入权限。在群聊并发回复模式中，未显式指定 Agent 代表调用群聊全部成员。

- 直接会话保留本地历史、附件、Skill、受控权限、兼容的原生 Session 和脱敏运行事件。
- 群聊“并发回复”在调度前为所有已选 Agent 冻结同一份任务快照，保留全部成员，并在批次屏障后按稳定顺序提交独立回复。
- Auto Discussion 从全员独立并行提案开始。已选 Agent 交叉质询并自主协商一份职责图；只有全员同意同一 `planHash` 后，Harness 才按该图调度各自的工作包。
- 提案、质询、分工工作和复核默认只读。开启工作区写入时，只有协商确定的整合者在合成阶段拥有写权，不同的复核 Agent 独立验证当前候选 Artifact。
- Harness 持久化冻结快照、阶段、槽位、结构化回执、Artifact/Evidence 引用、交付水位、Human Gate 和幂等提交状态，并把待处理 Gate 与恢复状态绑定到产生它的精确 Agent 执行尝试。它验证协作协议，不在 Agent 之外私下分配职责。
- 未决权限 Gate 完成前，Harness 不接受 Agent 终态结果，也不推进 V4 阶段。明确失败的 checkpoint 会回滚到此前持久状态；结果未知的 post-write 异常保持单调状态并交由 Ledger 恢复，避免倒退覆盖已落盘进展。
- 用户可停止 Run 或指定 Agent，检查阶段、异议、候选产物和恢复选项，并保留最终采用决定。

当前不承诺从大规模候选池自动选人组队、生产级 Cloud/Channel Agent、跨用户远程协作、企业 RBAC/治理、Outcome Network，也不承诺目录中每个 Agent 都已通过实时发布认证。

## V1.0.3 预发布产物

DMG、ZIP 和 `SHA256SUMS.txt` 来自最终源码状态和同一次 `npm --prefix desktop run dist` 构建。Release Notes 与远端资产使用该批次的校验值，不复用任何更早候选产物。

每次发布必须对新生成的 DMG 和 ZIP 执行 `shasum -a 256`，生成同批次的 `SHA256SUMS.txt`。上传后还必须重新下载或读取远端资产，确认远端字节与本地最终构建一致。

## 验收状态

- 前端测试 `306/306`、桌面测试 `1338/1338` 通过；确定性 Eval Harness 共 `6` 个案例、`18` 个结果通过。
- Web 与 Electron renderer 两个构建、Electron `pack`、`dist`、DMG/ZIP 完整性检查和 `git diff --check` 通过。
- V1.0.2 的 Hermes 实时流式与工具生命周期证据继续适用于未变更路径；Manual V4 已有 Codex、Claude、Hermes 完成证据，Auto Discussion V4 已有 Codex、Claude 完成证据。V1.0.3 未重新执行全部实时 Agent 矩阵。OpenClaw 最新实时运行以 `LOCAL_AGENT_PROCESS_FAILED` 安全失败，因此只声明协议夹具和托管运行时测试通过，不声明 OpenClaw 实时认证通过。
- `360 x 800` 群聊与私聊回到底部、Trace、消息操作和停止耐久性验收通过。打包应用进一步确认未使用 `@` 时会解析为群聊全部 Agent，并确认有限轮与不限轮输入框使用同一表面样式。一次 Codex 私聊运行超过 300 秒观察窗口后才迟到完成，最终 UI 验收使用 Claude 私聊并保留该实时延迟边界。
- 以上验证不覆盖所有目录 Agent、安装配方、上游版本或操作系统。该版本仍为 ad-hoc 签名，未使用 Apple Developer ID，也未提交 Apple 公证。

完整的自动化证据、实时 Agent 边界和剩余风险见[Verification And Test Coverage](tests.md)。

## 未来正式签名发行

计划中的 GitHub prerelease 不代替正式签名公开发行。要让应用在全新 Mac 上直接通过 Gatekeeper，后续发行仍必须：

1. 使用有效的 `Developer ID Application` 证书和完整的 Apple 公证凭据。
2. 从干净标签运行 `npm --prefix desktop run dist:public`，不允许明文凭据或 ad-hoc 降级。
3. 验证 Developer ID 身份、永久 Bundle ID `com.rydersun.meldwork`、Hardened Runtime、Apple 公证、Stapling 和 Gatekeeper。
4. 在没有历史 Meldwork 数据的全新 Apple silicon Mac 账户中安装 DMG 并正常双击启动。

详细操作见 [macOS Developer ID 签名与 Apple 公证](macos-signing.md)。
