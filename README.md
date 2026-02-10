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
