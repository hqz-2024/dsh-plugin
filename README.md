# DeepSeek Harness 局域网部署说明

本目录（`~/.dsh/`）存放局域网部署所需的配置和脚本。核心架构：**dsh 只监听本机 127.0.0.1，caddy 作为 HTTPS 反代对外**，这样 agent 的远程代码执行能力仍被圈在本机，不直接暴露到网络。

```
局域网设备 ── HTTPS ──> caddy (0.0.0.0:8443) ── HTTP ──> dsh (127.0.0.1:3080)
```

---

## 一、前置要求

- **Node.js**：22.19+ 或 24+（本机为 `C:\nvm4w\nodejs\node.exe`）
- **pnpm**：通过 corepack 启用（`corepack enable`，项目锁定 `pnpm@11.7.0`）
- **dsh 源码**：`C:\Users\bestarc\Desktop\deepseek-harness`（已 `pnpm install`）

---

## 二、caddy 下载与安装

caddy 是成熟的泛用反向代理，用 winget 安装：

```powershell
winget install --id CaddyServer.Caddy -e --silent --accept-package-agreements --accept-source-agreements
```

> 安装后 caddy 的可执行文件在 winget 的带哈希路径下（升级后会变），所以已把它复制到固定路径 `C:\Users\bestarc\.dsh\bin\caddy.exe`，脚本统一用这个路径。若重装 caddy，重新执行一次复制即可：
>
> ```powershell
> mkdir -p $env:USERPROFILE\.dsh\bin
> copy "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\CaddyServer.Caddy_*\caddy.exe" "$env:USERPROFILE\.dsh\bin\caddy.exe"
> ```

---

## 三、caddy 配置（Caddyfile）

文件：`C:\Users\bestarc\.dsh\Caddyfile`

```
https://192.168.28.239:8443 {
	tls internal
	reverse_proxy 127.0.0.1:3080
}
```

- `tls internal`：用 caddy 本地 CA 签发自签证书（首次运行会把根证书装进本机 Windows 信任库）。
- `reverse_proxy 127.0.0.1:3080`：反代到 dsh，caddy 自动转发 WebSocket 升级，无需额外配置。
- 端口 8443 可改（改成 443 需要管理员权限）。

---

## 四、dsh 启动命令

dsh 必须**只监听本机 127.0.0.1**，但用 `--trusted-host` 放行从 caddy 转发来的请求：

```powershell
cd C:\Users\bestarc\Desktop\deepseek-harness
pnpm dsh --profile web --trusted-host 192.168.28.239
```

> 说明：dsh 的 CLI 故意禁止 `--host 0.0.0.0`（会暴露远程代码执行），所以局域网开放必须走 caddy 反代。`--trusted-host 192.168.28.239` 让 browser-trust 栅栏放行 Host 为 `192.168.28.239` 的请求。

---

## 五、一键启动脚本

文件：`C:\Users\bestarc\.dsh\start-dsh-lan.cmd`

双击运行，会同时拉起 caddy 和 dsh（各开一个最小化窗口）。脚本里的关键路径：

| 变量 | 值 |
|---|---|
| `NODE` | `C:\nvm4w\nodejs\node.exe` |
| `CADDY` | `C:\Users\bestarc\.dsh\bin\caddy.exe` |
| `CADDYFILE` | `C:\Users\bestarc\.dsh\Caddyfile` |
| `DSH_DIR` | `C:\Users\bestarc\Desktop\deepseek-harness` |
| `LAN_IP` | `192.168.28.239` |

若机器 IP 变了，改脚本里的 `LAN_IP` 和 `Caddyfile` 里的地址即可。

---

## 六、开机自启

把启动脚本放到 Windows 启动文件夹，登录后自动运行：

1. `Win + R` 打开运行框，输入 `shell:startup` 回车。
2. 把 `C:\Users\bestarc\.dsh\start-dsh-lan.cmd` 的**快捷方式**放进去（右键脚本 → 创建快捷方式，再把快捷方式移入启动文件夹）。

或者用任务计划程序（可设隐藏窗口、延迟启动）：

```powershell
schtasks /Create /TN "dsh-lan" /TR "C:\Users\bestarc\.dsh\start-dsh-lan.cmd" /SC ONLOGON /RL LIMITED /F
```

---

## 七、局域网设备访问与证书信任

- 访问地址：`https://192.168.28.239:8443`
- caddy 的自签根证书只装在本机。**其他设备首次访问会提示证书不受信**，需要在每台设备上手动信任根证书，证书位置：
  `C:\Users\bestarc\AppData\Roaming\Caddy\pki\authorities\local\root.crt`
- 若 Windows 防火墙拦了 8443，需加一条入站规则放行。

---

## 八、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 局域网设备连不上 8443 | Windows 防火墙未放行 8443；或 IP 变了 |
| 提示证书不受信 | 在设备上手动信任 caddy 的 root.crt |
| caddy 报 502 | dsh 没启动（先起 dsh 再起 caddy） |
| dsh 启动报 schema 错误 | 某个插件 tool 的 JSON Schema 不合法（`required` 在 items 里、object 缺 `additionalProperties` 等），按 dsh 的 value-schema DSL 规则修 |
