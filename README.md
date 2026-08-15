# dsh-warp-input — DSH 输入框增强插件（Warp 风格）

DSH web 常驻插件：把对话输入框升级为 Warp 风格的「命令/对话」双模式输入。

## 功能

- **智能识别命令 vs 对话**（无需 `$` 前缀）：常见命令词表 + shell 操作符 + CJK 判定 +
  未知词可执行探测（`/warp/check`）；`$` 或反引号开头可强制命令；徽标可点击手动切换。
- **结果进对话流**：命令通过注册的 `/run` 命令在**会话目录**执行，结果作为命令节点
  渲染进对话（默认展开，支持复制 / 收起）。
- **双历史**：命令与对话消息统一历史，`↑`/`↓` 按原模式召回；localStorage 持久化，重启保留。
- **多行命令**：支持粘贴多行 shell 脚本。
- **斜杠透传**：`/plan` 等 DSH 内建斜杠命令不受影响。
- **环境适配**：执行时注入标准 macOS PATH（含 Homebrew），npm/brew 等可用。

## 安装

```bash
dsh plugin --profile web add dsh-warp-input@file:<本仓库路径>
# 重启 harness（dsh web）后对所有会话生效；客户端代码改动刷新页面即可（服务端自动重扫）
```

## 使用

| 输入 | 行为 |
|---|---|
| `ls -la`、`git status`、`npm run build` | 识别为命令 → 执行 → 结果进对话流 |
| 中文 / 自然语言 | 正常对话 |
| 识别错误 | 点击输入框左侧徽标手动切换（虚线 = 手动模式） |
| `$ cmd` 或 `` `cmd` `` | 强制命令 |
| 空输入框 `↑` | 召回上一条历史（命令或对话） |

## 结构

- `lib/index.js` — host 半：`/run` 命令注册、`/warp/check` 探测路由、PATH 注入
- `lib/client.js` — client 半：composer 接管、智能识别、历史、命令节点视图
- `cordis.patch.yml` — bundle patch（插入 `warp-input` 插件行）

## 许可证

MIT（代码）。图标素材等不包含在本仓库。
