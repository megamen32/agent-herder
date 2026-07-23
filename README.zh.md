# Agent Herder

[English](README.md) | [Русский](README.ru.md) | **中文**

Agent Herder 是一个 MCP 服务器，通过统一接口监控和管理 OpenCode、Claude Code 与 Codex CLI 会话。

![Agent Herder 开发工作台](docs/assets/readme-hero.png)

## 快速开始

在本地 checkout 中用一条命令安装依赖并构建服务器：

```bash
npm ci && npm run build
```

构建后的 stdio 入口是 `dist/index.js`。在 Claude Code 中注册当前 checkout：

```bash
claude mcp add agent-herder -- node "$PWD/dist/index.js"
```

在 Cursor、OpenCode 或其他 MCP 客户端中，也请在配置里使用 `dist/index.js` 的绝对路径。启用 OpenCode 适配器时，请先运行 `opencode serve`。

## 功能

- 列出会话及其状态、模型、费用和最近活动；
- 向 agent 发送消息、恢复会话或停止运行中的 agent；
- 处理权限请求并修改 permissions；
- 切换模型并生成会话摘要。

## 要求与配置

需要 Node.js、npm，以及至少一个受支持的 CLI：`opencode`、`claude` 或 `codex`。使用 Codex 时请设置 `OPENAI_API_KEY`。

常用环境变量：

| 变量 | 作用 |
|---|---|
| `ENABLE_OPENCODE`、`ENABLE_CLAUDE`、`ENABLE_CODEX` | 启用适配器，默认均为 `true` |
| `OPENCODE_URL` | OpenCode 地址，默认 `http://127.0.0.1:4096` |
| `CLAUDE_BIN`、`CODEX_BIN` | CLI 可执行文件路径 |
| `CODEX_DATA_DIR` | Codex 数据目录，默认 `~/.codex` |
| `SUMMARIZER_API_KEY` | `summarize_session` 工具使用的密钥 |

完整的环境变量表、客户端配置、架构和各 harness 的说明请参阅[英文 README](README.md)。

## MCP 工具

`list_agents`、`agent_info`、`send_message`、`resume_agent`、`stop_agent`、`respond_permission`、`set_permissions`、`summarize_session`、`change_model` 和 `list_models`。

## 开发

```bash
npm run dev      # TypeScript watch mode
npm run build    # 编译
npm run inspect  # MCP Inspector
```

## 许可证

MIT
