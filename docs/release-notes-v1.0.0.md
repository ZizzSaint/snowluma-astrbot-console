# SnowLuma × AstrBot 控制台 v1.0.0

把 **SnowLuma**（本机 QQ → OneBot v11）和 **AstrBot**（LLM 机器人框架）收进同一个 Windows 窗口：一个应用里完成下载、安装、启动、更新、桥接和内嵌控制台，全程不弹出终端控制台窗口。

## 下载

| 文件 | 说明 |
| --- | --- |
| `SnowLumaAstrBotConsole-Setup-1.0.0.exe` | **NSIS 安装包**（106 MB，Windows 10/11 x64）。双击安装，可选安装目录、创建桌面/开始菜单快捷方式 |
| `SHA256SUMS.txt` | 安装包校验值 |

### 如果只看到 `.part01` … 分片

构建这台机器到 GitHub 的国际链路被严重限速（单连接约 15–80 KB/s，长连接还会被重置），
所以 106 MB 的安装包是**分片上传**的。合并只需要一步：

1. 把 `SnowLumaAstrBotConsole-Setup-1.0.0.exe.part01` ~ `.part06`、`join-installer.cmd`、`SHA256SUMS.txt`
   下载到**同一个目录**（分片顺序按文件名，part01 → part06）；
2. 双击 `join-installer.cmd` —— 它会按顺序合并出 `SnowLumaAstrBotConsole-Setup-1.0.0.exe`，
   并打印合并结果的 SHA256；
3. 校验：结果应为

```
8d2dcf253847367b1192259f7d17280fcd45d25a2aea3d1f3694236d376c3a78
```

各分片自身的校验值见 `SnowLumaAstrBotConsole-Setup-1.0.0.exe.parts.txt`。

> 国内网络如果直连 `github.com/.../releases/download/...` 超时，可在下载地址前拼一个镜像前缀，例如：
> `https://ghproxy.net/https://github.com/ZizzSaint/snowluma-astrbot-console/releases/download/v1.0.0/<文件名>`
> 应用内部下载 SnowLuma / AstrBot 时也会自动做同样的镜像回退，无需手动处理。

## 主要功能

- **应用内启动与管理**：一键下载/安装/启动/停止/重启/更新 SnowLuma 与 AstrBot，全部通过隐藏窗口的子进程完成，**不会出现任何终端控制台窗口**。
- **内嵌控制台**：SnowLuma WebUI（`5099`）与 AstrBot 面板（`6185`）直接显示在应用里，独立会话分区；工具栏 **🔑 一键登录** 自动完成面板登录。
- **安装位置全程可见**：安装前弹确认框列出程序目录 / 数据目录 / 虚拟环境 / 下载缓存；卡片与设置页常驻显示并支持「打开」「复制」。
- **更新保留数据**：程序目录整体替换，`instances/` 下的配置、插件、数据库、会话记录不受影响。
- **一键桥接**：自动写入 AstrBot 的 OneBot v11 反向 WS 与 SnowLuma 的反向 WS 客户端配置，并重启生效；内置图文桥接教程与常见问题。
- **数据目录迁移**：把整个数据目录搬到别的盘（robocopy 多线程 → 文件数/体积校验 → 删旧目录 → 切换根目录），校验不过就保留原目录；另支持便携模式（`portable.txt`）。
- **冻结 QQ 自动更新**：应用内读取 hosts 状态并一键冻结/解除（`qqpatch.gtimg.cn` → `0.0.0.0`），避免 QQ 自动升级导致 SnowLuma 的 native hook 失效；改 hosts 只在需要时弹 UAC，不弹终端。
- **环境自适应**：探测本机 QQ 版本/架构、Node 版本、Python 版本，自动挑 SnowLuma 精简版（本机 Node 足够时）或完整版；AstrBot 自动创建 venv 并安装依赖。
- **网络容错**：GitHub 直连优先、失败自动切镜像，支持断点续传与 SHA256 校验；pip 依赖多源回退。

## 系统要求

- Windows 10 / 11 x64
- 桌面版 QQ（NTQQ）——SnowLuma 需要注入 `QQ.exe` 才能登录
- AstrBot 需要 Python ≥ 3.12（应用会自动检测并创建虚拟环境）
- 首次使用 AstrBot 后需在面板里配置模型提供商（API Key），机器人才会回复消息

## 安装后

1. 打开应用 → **总览** 页确认本机环境检测正常
2. SnowLuma 卡片点 **⬇ 下载安装**；AstrBot 卡片点 **⬇ 下载安装**（依赖较多，通常 3~10 分钟）
3. **▶ 一键启动全部** → 侧边栏两个控制台分别用 **🔑 一键登录** 进入
4. SnowLuma 控制台里用手机 QQ 扫码登录 → **桥接教程 → 一键完成**
5. AstrBot 面板里配置模型提供商，然后用另一个 QQ 给机器人发 `/help` 验证

卸载**不会**删除 SnowLuma/AstrBot 的数据（`%APPDATA%\SnowLumaAstrBotConsole\data` 或你迁移后的数据根目录）。

## 说明

- 本仓库只是启动器外壳，**不包含** SnowLuma 与 AstrBot 的任何代码或二进制；它们由应用在运行时从各自的官方仓库下载（SnowLuma、AstrBot 均为 AGPL-3.0）。
- 安装包内含 Electron 运行时，因此体积较大；源码运行方式见 README。
- 截图中的个人账号与群消息内容均已遮盖处理。
