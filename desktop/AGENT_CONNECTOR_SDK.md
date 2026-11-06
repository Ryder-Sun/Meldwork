# Agent Connector SDK

Meldwork 的 Connector 包是经校验的本地 JSON 文件。包通过内容哈希标识，导入后必须经用户批准和安装，才能配置实例。每个实例独立保存 CredentialRef；凭据由 Electron 的系统安全存储加密，Connector 列表不会返回凭据明文。

使用实例凭据的 Codex 委托 Connector 在每个实例独立的私有原生配置目录中运行，不读取全局 Codex 或 XDG 配置。实例密钥通过 Codex 原生 `CODEX_API_KEY` 环境变量传入，不写入该目录；目录保留会话数据，以支持实例自己的续聊。

## 当前支持范围

SDK 版本为 `1.0.0`，目前提供两个内置 Provider：

- `sdk.local-echo.v1`：本地回显，仅支持文本、只读，无需网络或凭据。
- `sdk.http-json.v1`：向清单声明的 HTTPS 目标发送 JSON 请求，支持文本和只读权限，可选一个必填的 API key 或 token 凭据槽；不跟随 HTTP 重定向。

HTTP 响应为 JSON 对象，必须包含字符串 `text`，可包含字符串 `sessionRef` 和 `outcome`。`outcome` 可为 `completed`、`partial`、`failed` 或 `cancelled`；省略时视为 `completed`。如果响应同时包含非空 `error` 或 `success: false`，则视为失败。失败结果使用通用错误码，避免把服务返回的敏感信息写入运行记录。取消结果要求清单声明取消能力。

HTTP 请求有十分钟传输超时。对于未声明取消能力的 Connector，停止任务会中止本地连接，但不会声称远端执行已取消。

第三方可以为这些 Provider 制作包，无需重建 Meldwork；**当前尚不能通过包注册任意第三方可执行代码或新的传输实现**。清单本身支持的能力不代表每个 Provider 都实现了该能力，包校验会拒绝超出 Provider 范围的声明。参见 [包校验实现](src/agents/connectors/agent-connector-package-store.cjs) 和 [端到端示例测试](test/agents/connectors/agent-connector-sdk.test.cjs)。

这两个 Provider 当前不支持检查点或持久幂等，也不产生权限、来源、产物、证据、用量或等待输入事件；包含这些能力声明的包会被拒绝导入。HTTP 请求会携带 `operationId`，但这本身不构成服务端持久去重的保证。

## 生成本地示例包

在仓库根目录安装桌面依赖后，执行以下命令生成示例，不需要提供凭据：

```sh
node - <<'NODE'
const fs = require('node:fs')
const { SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE } = require('./desktop/src/agents/connectors/agent-connector-local.cjs')
const { serializeAgentConnectorPackage } = require('./desktop/src/agents/connectors/agent-connector-package-store.cjs')
fs.writeFileSync('/tmp/meldwork-local-echo.connector.json', serializeAgentConnectorPackage(SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE))
NODE
```

该命令输出到 macOS/Linux 的临时目录；Windows 用户可将目标改为自己可写的绝对路径。HTTP 包的完整构造示例见上述 `agent-connector-sdk.test.cjs` 中的 `httpPackage()`；应使用 `createAgentConnectorManifest` 和 `createAgentConnectorPackage` 生成哈希，而不是手工修改已有包的标识。

## 导入与生命周期

桌面主进程和预加载层提供 `localAgentConnector` 接口：`import`、`inspect`、`approve`、`install`、`configure`、`test`、`disable`、`revoke`、`upgrade`、`remove` 和 `audit`。导入通过系统文件选择器完成；批准时会展示发布者、来源、哈希、传输、权限、凭据槽和外联目标，并要求用户确认。实例仍在使用时，不能直接删除或升级对应的包。

设置页面的“Connector 管理”提供导入、查看、批准、安装、测试和信任管理入口，不向网页提供任意命令执行能力。目前界面只能创建不需要凭据的实例；需要凭据的实例尚无安全配置入口。

`test` 执行一次只读提示，在独立的临时工作目录运行，并在结束后清理。它是连通性检查，不是对 Provider 所有功能和安全行为的完整认证。

## 能力与事件

清单声明的输入类型、权限、会话、取消、事件类型、用量字段和外联目标在运行时受约束。HTTP 目标必须与声明的 HTTPS origin 匹配。`Usage` 只统计事件实际报告的字段；缺失的回复 token 用量由运行预算估算，返回值不得伪造未声明或与事件不一致的用量。

事件及其必填字段以 [Run Event 协议](src/runs/run-event-protocol.cjs) 和 [Manifest 校验](src/agents/connectors/agent-connector-manifest.cjs) 为准。不要把 API key 放入清单、请求正文或示例包。

## 验证

```sh
npm --prefix desktop run connector:conformance
```

该命令运行 Manifest、注册表、运行时、实例、安装包、SDK、实际 Connector 接线和主进程安全测试，包括非委托的本地回展示例、多账号凭据隔离以及渲染进程边界。它验证当前内置 Provider 的行为，不代表第三方服务已经通过独立认证。
