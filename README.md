# OSS Quick Upload

<p align="center">
  <img src="./pic/22c0b5eb-bcd2-4ba0-8176-453bf53720e6.png" alt="OSS Quick Upload 上传中心" width="100%">
</p>

<table>
  <tr>
    <td width="50%" align="center"><img src="./pic/ScreenShot_2026-08-08_211000_003.png" alt="浏览整个 OSS 账号" width="100%"><br><sub>浏览整个 OSS 账号</sub></td>
    <td width="50%" align="center"><img src="./pic/9e821ba0-98b1-4c7a-a6b8-d656a13b6d97.png" alt="浏览预设 OSS 路径" width="100%"><br><sub>浏览预设 OSS 路径</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="./pic/ScreenShot_2026-08-08_210909_409.png" alt="OSS 账号配置" width="100%"><br><sub>OSS 账号配置</sub></td>
    <td width="50%" align="center"><img src="./pic/ScreenShot_2026-08-08_211042_046.png" alt="常用路径配置" width="100%"><br><sub>常用路径配置</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="./pic/ScreenShot_2026-08-08_211059_068.png" alt="上传并发与同名文件设置" width="100%"><br><sub>上传设置</sub></td>
    <td width="50%"></td>
  </tr>
</table>

OSS Quick Upload 是一款面向阿里云 OSS 的 Windows 桌面客户端。它将常用 Bucket 和目录保存为预设路径，上传时只需选择 OSS 账号和目标路径，不必反复查找或输入完整目录。

项目同时提供 OSS 文件浏览与管理能力（上传、下载、删除、重命名、复制、移动、获取地址），可按整个账号或预设路径查看内容，适合软件发布、构建产物归档、资源同步和日常文件管理。

## 主要功能

### 上传中心

- 多 OSS 账号管理，账号凭据只需配置一次，Secret 通过系统能力加密保存。
- 为不同账号创建任意数量的常用路径，并添加用途备注，支持一键复制完整 OSS 地址。
- 同一批文件可同时上传到多个 OSS 路径。
- **文件夹版本选择**：选择本地项目根目录后弹出树形面板，可多级展开、勾选其中要上传的版本 / 子文件夹（多选），上传后按勾选目录保留层级结构（如 `v1.0/build/app.zip`）。
- **子目录输入框**：可输入一个子目录名，为本次队列在 OSS 目标路径下先套一层文件夹；输入后开始上传前会弹出目标路径确认。
- 独立上传队列展示进度、状态和失败原因，支持取消全部、清空已完成、失败任务手动重试。
- 可配置并发上传任务数与同名文件覆盖 / 跳过策略。
- 运行日志通过页面右上角按钮打开弹窗查看完整记录。

### OSS 文件

- “整个账号”和“预设路径”两种查看模式，支持跨 Region 浏览 Bucket，一键复制当前路径。
- **上传到当前目录**：可直接向正在浏览的目录上传本地文件或整个文件夹（文件夹保留相对结构），右上角按钮实时查看上传进度。
- 下载单个文件、多个文件或完整文件夹，递归保留目录结构。
- **删除 / 重命名**：支持文件和文件夹（文件夹操作会自动递归处理其下所有对象），删除前弹窗确认。
- **复制 / 移动**：选中对象后通过可视化目录选择器浏览并选择目标目录，文件夹连同内容整体转移。
- **获取地址**：生成签名地址（有效期可选 1 小时 / 1 天 / 7 天）与长期公开地址，一键复制。

## 使用流程

1. 在“设置 > 账号配置”中添加 OSS 账号，填写 Endpoint、Region、AccessKey ID 和 AccessKey Secret。
2. 在“设置 > 常用路径”中选择账号，配置 Bucket、目录前缀、路径名称和备注。
3. 返回“上传中心”，选择 OSS 账号和一个或多个上传路径。
4. 添加文件或文件夹（文件夹可先选项目根目录，再在树形面板勾选版本 / 子目录），可按需填写子目录。
5. 点击开始上传（填写了子目录时会先弹出目标路径确认），上传过程可在右上角查看运行日志。
6. 在“OSS 文件”中按账号或预设路径浏览内容，可下载、删除、重命名、复制 / 移动对象，或上传本地文件到当前目录。

## 凭据安全

AccessKey Secret 不会以明文写入配置文件。应用使用 Electron `safeStorage` 调用操作系统提供的加密能力保存凭据；界面读取配置时只返回凭据是否已保存，不会返回 Secret 原文。

仍建议为本工具创建遵循最小权限原则的 RAM 用户，只授予实际需要访问的 Bucket 和操作权限。

## 开发环境

- Windows 10/11
- Node.js 20 或更高版本
- npm

安装依赖并启动开发环境：

```powershell
npm install
npm run dev
```

执行类型检查：

```powershell
npm run typecheck
```

生成生产构建：

```powershell
npm run build
```

## Windows 打包

双击项目根目录下的 `build.bat`，或在终端执行：

```powershell
build.bat --no-pause
```

脚本会自动安装依赖、执行类型检查和生产构建，并在 `release` 目录生成：

- `OSS Quick Upload Setup 0.1.0.exe`：Windows 安装程序。
- `OSS Quick Upload 0.1.0.exe`：免安装便携程序。

## 技术栈

- Electron
- React
- TypeScript
- electron-vite / Vite
- ali-oss
- lucide-react
- electron-builder

## 项目结构

```text
OssUpload/
|-- src/
|   |-- main/              # Electron 主进程、OSS 请求及本地文件处理
|   |-- preload/           # 安全的渲染进程 IPC 桥接
|   |-- renderer/          # React 用户界面
|   `-- shared/            # 主进程与渲染进程共享类型
|-- pic/                   # 项目截图
|-- build.bat              # Windows 一键打包脚本
|-- electron.vite.config.ts
|-- package.json
`-- README.md
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Electron 开发环境 |
| `npm run typecheck` | 执行 TypeScript 类型检查 |
| `npm run build` | 生成主进程、预加载和渲染进程构建 |
| `npm run dist` | 生成 Windows 安装版和便携版 |
| `build.bat --no-pause` | 执行完整 Windows 打包流程 |