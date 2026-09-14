# lib —— LibreOffice 自动准备

用于把生成的 DOCX 转成 **旧版 Word 二进制 `.doc`**。
应用会**按运行环境自动准备**对应平台的 LibreOffice，部署时无需手动安装。

## 平台支持

| 环境 | 转换器来源 |
|---|---|
| Linux x86_64 | 优先用 `lib/debs` 离线解包；没有则下载官方 deb 归档解包 |
| Linux arm64 | 下载官方 aarch64 deb 归档解包 |
| macOS x86_64（Intel） | 优先用系统已安装的 LibreOffice；没有则下载官方 x86-64 `.dmg` 解包到 `lib/` |
| macOS arm64（Apple Silicon） | 同上，下载 aarch64 `.dmg` |
| 其它 | 仅支持系统已安装或 `LIBREOFFICE_BIN` 显式指定 |

> Linux 的 `.deb` 是 ELF 二进制，**不能**在 macOS 上运行；反过来 macOS 的 `.app` 也不能在 Linux 上跑。所以按平台分别准备。

## 目录

```
lib/
  debs/                       # Ubuntu x86_64 的 .deb（已提交，约 92MB，43 个）
  libreoffice-<arch>/         # Linux 解包产物（自动生成，已 gitignore）
  libreoffice-mac-<arch>/     # macOS 的 LibreOffice.app（自动生成，已 gitignore）
```

## 为什么提交的是 .deb，而不是解包后的文件？

解包后有一个约 **105MB** 的 `program/libmergedlo.so`，超过 GitHub 单文件 100MB 硬上限，
普通 git 无法推送；而每个 `.deb` 都远小于 100MB，可以安全提交。
macOS 的 `.dmg` 更大（约 350MB），因此完全改为首次使用时自动下载。

## 自动安装逻辑

`src/libreoffice-portable.mjs` 按以下顺序解析：

1. `LIBREOFFICE_BIN` / `SOFFICE_BIN` 环境变量；
2. `lib/` 下已有的解包产物；
3. 系统已安装的 LibreOffice（macOS 的 `/Applications/LibreOffice.app`、PATH 里的 `soffice`）；
4. 都没有且未禁用自动安装时：
   - **Linux**：解包 `lib/debs`；没有则下载官方 deb 归档再解包；
   - **macOS**：下载官方 `.dmg`，用 `hdiutil` 挂载、`ditto` 安装到 `lib/`，并去掉 `com.apple.quarantine`。

自动安装默认在**服务启动后于后台进行**，不会阻塞启动；装好后 `.doc` 自动可用。
也可以提前手动安装：

```bash
npm run setup:libreoffice
```

## 环境变量（可选）

| 变量 | 说明 |
|---|---|
| `LIBREOFFICE_BIN` | 直接指定 `soffice`，跳过所有自动逻辑 |
| `LIBREOFFICE_AUTO_INSTALL` | 设为 `0` / `false` 关闭自动下载安装 |
| `LIBREOFFICE_VERSION` | 指定版本，默认自动取 `stable` 最新版 |
| `LIBREOFFICE_MIRROR` | 镜像根地址，默认 `https://download.documentfoundation.org/libreoffice`（国内可换成对应镜像） |
| `LIBREOFFICE_LD_LIBRARY_PATH` | 自定义动态库路径 |
| `LIBREOFFICE_TIMEOUT_MS` | 单次转换超时，默认 `120000` |

## 依赖

- Linux：需要 `dpkg-deb`（Ubuntu/Debian 自带）、`tar`
- macOS：需要系统自带的 `hdiutil`、`ditto`、`xattr`
