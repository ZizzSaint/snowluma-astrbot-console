# SnowLuma × AstrBot 控制台 v1.1.0

本次更新：**关闭窗口 = 缩进系统托盘**，SnowLuma / AstrBot 继续在后台运行，QQ 机器人不掉线。

## 新增

- **托盘常驻**：窗口右上角关闭按钮不再退出应用，而是把窗口收进系统托盘；两个服务继续跑。
- **托盘菜单**：右键托盘图标 → 显示主窗口 / 隐藏到托盘 / 实时状态（SnowLuma：运行中·已停止·未安装）/ ▶ 启动全部服务 / ⏹ 停止全部服务 / 打开数据目录 / 打开日志目录 / **退出（同时停止两个服务）**。
- **托盘交互**：左键单击 = 显示/隐藏窗口（悬停提示里带两个服务的实时状态），双击 = 显示窗口。
- **最小化也进托盘**：点窗口最小化按钮同样收进托盘，不占任务栏。
- **首次提示**：第一次收进托盘会弹一次气泡，告诉你怎么找回窗口、怎么彻底退出。
- **可关闭该行为**：设置 → 运行时 → 「关闭窗口时最小化到托盘」取消勾选即可恢复"关闭即退出"；旁边有「立即最小化到托盘」按钮，总览页快捷操作里也有一个。
- 菜单栏新增「文件 → 隐藏到托盘」（快捷键 `Ctrl+W`），「退出」明确写成「退出（同时停止两个服务）」。

## 下载

| 文件 | 说明 |
| --- | --- |
| `SnowLumaAstrBotConsole-Setup-1.1.0.exe` | **NSIS 安装包**（Windows 10/11 x64），可选安装目录、创建桌面/开始菜单快捷方式 |
| `SnowLumaAstrBotConsole-Setup-1.1.0.exe.part01` … | 同一安装包的分片（见下方说明） |
| `join-installer.cmd` | 分片合并脚本（合并后会打印 SHA256 供校验） |
| `SHA256SUMS.txt` / `*.parts.txt` | 安装包与各分片的校验值 |

### 如果只看到 `.part01` … 分片

构建这台机器到 GitHub 的国际链路被严重限速（单连接 15–80 KB/s，长连接还会被重置），
所以 106 MB 的安装包是**分片上传**的。合并只需要一步：

1. 把 `SnowLumaAstrBotConsole-Setup-1.1.0.exe.part01` … 全部分片、`join-installer.cmd`、`SHA256SUMS.txt`
   下载到**同一个目录**（顺序按文件名，part01 → partNN）；
2. 双击 `join-installer.cmd` —— 合并出 `SnowLumaAstrBotConsole-Setup-1.1.0.exe` 并打印 SHA256；
3. 与 `SHA256SUMS.txt` 里的值比对。

> 国内网络如果直连 `github.com/.../releases/download/...` 超时，可在下载地址前拼镜像前缀，例如：
> `https://ghproxy.net/https://github.com/ZizzSaint/snowluma-astrbot-console/releases/download/v1.1.0/<文件名>`

## v1.0.0 起就有的能力（回顾）

应用内下载/安装/启动/停止/更新 SnowLuma 与 AstrBot（全程无终端窗口）、内嵌两者控制台并一键登录、
安装位置全程可见、更新保留数据、一键桥接 QQ、数据目录迁移与便携模式、应用内冻结 QQ 自动更新、
多镜像回退下载与环境自适应（QQ / Node / Python 探测）。

卸载**不会**删除 SnowLuma/AstrBot 的数据（数据根目录默认在 `%APPDATA%\SnowLumaAstrBotConsole\data`，
或你迁移后的位置）。
