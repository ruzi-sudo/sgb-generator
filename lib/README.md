# lib —— 内置便携版 LibreOffice

用于把生成的 DOCX 转成 **旧版 Word 二进制 `.doc`** 和 **PDF**。

## 平台支持

| 平台 | 转换器来源 |
|---|---|
| **Linux** | 优先 `lib/debs` 自动解包出的便携版；缺失时回退系统 `soffice` |
| **macOS** | ❌ `lib/debs` 是 Linux ELF 二进制，**在 macOS 上无法运行**；需安装 macOS 版 LibreOffice |

### macOS

```bash
brew install --cask libreoffice
# 或从官网下载 .dmg 安装到 /Applications
```

代码会自动探测 `/Applications/LibreOffice.app/Contents/MacOS/soffice`；
也可显式指定：

```bash
LIBREOFFICE_BIN=/Applications/LibreOffice.app/Contents/MacOS/soffice node src/server.mjs
```

> Rosetta 2 只能跑 x86-64 的 **macOS** 程序，不能跑 Linux ELF，所以 Linux 的 .deb 在 M 系列或 Intel Mac 上都用不了。

## 目录

```
lib/
  debs/             # Ubuntu 的 .deb 安装包（已提交，约 92MB，43 个）
  libreoffice/      # 解包产物（自动生成，已 gitignore，约 310MB）
```

## 为什么提交的是 .deb，而不是解包后的文件？

解包后有一个约 **105MB** 的 `program/libmergedlo.so`，超过 GitHub 单文件 100MB 硬上限，
普通 git 无法推送；而每个 `.deb` 都远小于 100MB，可以安全提交。

## 工作机制（Linux）

应用启动 / 首次转换时，`src/libreoffice-portable.mjs` 会：

1. 检查 `lib/libreoffice/usr/lib/libreoffice/program/soffice` 是否存在；
2. 不存在则用 `dpkg-deb -x` 把 `lib/debs/*.deb` 解包到 `lib/libreoffice/`；
3. 做脱离系统路径的必要修补：
   - 改写 `program/fundamentalrc` 的 `BRAND_BASE_DIR` 为实际绝对路径；
   - 用 `share/.registry/main.xcd` 替换指向 `/etc/libreoffice/...` 的失效软链；
   - 修补 `share/prereg/bundled`、`share/uno_packages/cache` 两个软链。

整个过程只做一次；删掉 `lib/libreoffice/` 后会重新解包。

## 环境变量（可选覆盖）

| 变量 | 说明 |
|---|---|
| `LIBREOFFICE_BIN` | 指定其它位置的 `soffice`，设置后不再使用内置版 |
| `LIBREOFFICE_LD_LIBRARY_PATH` | 自定义便携版的动态库路径 |
| `LIBREOFFICE_TIMEOUT_MS` | 单次转换超时，默认 `120000` |

> 也可以直接 `sudo apt install libreoffice-writer`（Linux），代码在找不到内置版时会回退到系统 `soffice`。
