# Desk Mew Pet

桌面喵喵萌宠

## 如何运行？

**推荐方式（只开一个终端）**

Tauri 会自动启动前端开发服务器，并打开桌面应用窗口。

```bash
pnpm tauri dev
```

> **说明**
> - 不需要再额外运行 `pnpm dev`
> - 如果你手动先跑了 `pnpm dev`，再跑 `pnpm tauri dev`，会导致端口被占用，Vite 可能自动切到 5174（容易引起"到底加载哪个端口"的混乱）

## 如何打包？

```bash
pnpm tauri:build:portable
```

该命令会生成免安装便携版可执行文件（Windows）：

`src-tauri/target/release/app.exe`

双击 `app.exe` 即可直接运行。

## OpenAI 兼容模型配置（headless）

桌宠会通过 `qwen` headless 子进程进行对话。你可以用两种方式提供 OpenAI 兼容配置：

1. 桌宠内置交互配置  
点击宠物打开输入框后，点 `模型配置`，填写并保存：
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`（可选）
- `OPENAI_MODEL`（可选）
- `工作目录`（可选，例如 `D:\assets`）
- `审批模式`（可选：`default` / `auto-edit` / `yolo` / `plan`）

保存后会在每次 `qwen_send` 时：
- 注入 OpenAI 兼容环境变量
- 用 `工作目录` 启动 qwen headless 子进程（作为进程当前目录）
- 把 `审批模式` 转成 qwen headless 参数 `--approval-mode`
- 当目录或审批模式发生变化时，自动重开一次 headless 会话（不走 `--continue`），避免沿用旧会话上下文。

> 提示：如果你希望它直接执行删除等命令，通常需要把审批模式设为 `yolo`。

2. 系统环境变量  
如果不在桌宠里填写，程序会沿用你系统已有环境变量，例如：

```bash
export OPENAI_API_KEY="your-api-key-here"
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OPENAI_MODEL="gpt-4o"
```
