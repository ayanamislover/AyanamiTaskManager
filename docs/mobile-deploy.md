# 手机端部署

在手机上看电脑里的项目和任务、发任务上来，还可以让电脑上的 Claude 自动接手。本文从零讲到能用。原理与安全设计见[手机同步说明](mobile-sync.md)。

ATM 不提供任何公共服务器。电脑和手机都只**向外**连接一个你自己部署的中继 `atm-relay`，在上面交换加密过的数据；中继只看得到密文、键名、大小和时间。

## 需要准备什么

| 东西                    | 要求                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 一台跑中继的机器        | 手机和电脑都能访问到它：云服务器、NAS，或家里一直开着的电脑。装 Docker，或 Node.js ≥ 22.13                                                     |
| HTTPS                   | 手机只接受 `https://` 的中继地址（只有 `127.0.0.1` / `localhost` 例外）。用域名 + 反向代理（Caddy、Nginx）或 Cloudflare Tunnel，下面有现成配置 |
| 电脑                    | 装好 ATM 3.0（Windows 10/11）                                                                                                                  |
| 手机                    | Android 10 或更新                                                                                                                              |
| Claude 自动开工（可选） | 电脑上装好 [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) 并登录；要派单的项目在 ATM 里绑定了源码目录                     |

## 第一步：部署中继

最省事的是 Docker。在 ATM 仓库根目录构建镜像（需要 BuildKit）：

```bash
git clone https://github.com/ayanamislover/AyanamiTaskManager.git
cd AyanamiTaskManager
docker build -f apps/relay/Dockerfile -t atm-relay .
docker run -d --name atm-relay --restart unless-stopped \
  -p 127.0.0.1:8790:8790 -v atm-relay-data:/data atm-relay
```

第一次启动会签发一枚 token。把它抄下来，然后删掉这个文件：

```bash
docker exec atm-relay cat /data/initial-token.txt
docker exec atm-relay rm /data/initial-token.txt
```

中继只监听本机 `127.0.0.1:8790`，由反向代理对外提供 HTTPS。用 Caddy 的话（自动申请证书，`relay.example.com` 换成你的域名）：

```caddyfile
relay.example.com {
	reverse_proxy 127.0.0.1:8790
}
```

没有公网 IP 的机器可以用 Cloudflare Tunnel，把 `relay.example.com` 指到 `http://127.0.0.1:8790`。Nginx 的写法、直接给证书文件、不用 Docker 直接跑、备份与升级，见[中继说明](../apps/relay/README.md)。

部署好之后，在手机浏览器里打开 `https://relay.example.com/health/live`，看到 `{"ok":true}` 就说明手机能连上它。

## 第二步：电脑上开启手机同步

1. 打开 ATM，进入「设置」，找到「手机同步」。
2. 填：
   - **中继地址**：`https://relay.example.com`
   - **应用 ID**：`atm`（中继第一次启动时建好的应用）
   - **中继 token**：第一步抄下来的那枚
   - **本机名称**：手机上显示的电脑名字，例如「书房电脑」
3. 点「测试连接」，通过后点「保存并启用」。
4. 点「添加手机」，弹出配对二维码和配对码。配对码只显示 2 分钟，没扫完就再点一次「添加手机」。

配对码里有中继 token 和配对密钥，**谁拿到它谁就能看你的任务、发任务**。不要截图发给别人。复制配对码之后，粘贴到手机上就清空剪贴板。

## 第三步：手机上安装并配对

1. 从 [Latest Release](https://github.com/ayanamislover/AyanamiTaskManager/releases/latest) 下载 `ATM-mobile-*-release.apk`，在手机上打开安装。第一次装需要允许「安装未知应用」。
2. 打开 App，扫电脑上的配对二维码，或者粘贴配对码。
3. 配对成功后，总览里会出现这台电脑和它的项目。电脑在线时，手机上的变化几秒内就到。

可以用 Release 附带的 SHA-256 核对下载的 APK。

要配第二部手机，再点一次「添加手机」给它扫。一台电脑就是一个配对空间；多台电脑可以共用一个中继，各自配对。

## 第四步（可选）：让 Claude 自动开工

1. 电脑上装好 Claude Code 并登录，然后重启 ATM。ATM 找不到 `claude` 命令行时，设置里会提示「没有找到 claude 命令行」。
2. 在「设置」里找到「Claude 自动开工」，打开「自动开工」。默认是关的；关着的时候，手机上的「交给 Claude」会被拒绝。
3. 按需要选「权限模式」和「同时运行」的会话数。「跳过全部确认」会让派出去的 Claude 会话不经确认执行任何命令、改任何文件，只在你信任的仓库里用。
4. 要派单的项目必须在 ATM 里绑定了源码目录，Claude 会在那个目录里工作。

之后在手机上新建任务时勾上「交给 Claude」，或者在任务详情里点「交给 Claude」。电脑收到后会拉起一个 Claude Code 会话：领取任务，补全目标和验收标准，然后开工。需要你拿主意时，任务会变成「等你回复」。

## 换手机、丢手机

配对码里的 token 是电脑和手机共用的。手机丢了，或者想让旧手机失效：

1. 在中继上撤销旧 token，再签一枚新的（Docker 里执行）：

   ```bash
   docker exec atm-relay atm-relay token list
   docker exec atm-relay atm-relay token revoke <旧 token 的 ID>
   docker exec atm-relay atm-relay token create --label 新手机
   ```

2. 在电脑的「手机同步」里换上新 token，再点「重置配对」。重置会换一把新的配对密钥，已经配对的手机全部失效。
3. 用新手机扫新的配对码。

## 常见问题

| 看到的                                   | 怎么办                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 中继地址必须是 https://                  | 手机和电脑都只接受 https 的中继地址。给中继配上反向代理或 Cloudflare Tunnel                                     |
| 中继没有响应                             | 先在浏览器里打开 `https://<你的域名>/health/live`；打不开就是中继、代理或 DNS 的问题                            |
| 中继不认这个 token（没带、填错或已吊销） | token 抄错了，或者已经被撤销。用 `token create` 签一枚新的                                                      |
| Windows 数据保护（DPAPI）当前不可用      | ATM 不会把 token 和配对密钥明文存盘，所以这时不能保存。重启电脑后再试；仍然不行看[排障指南](troubleshooting.md) |
| 手机上一直显示「等待电脑接收」           | 电脑上的 ATM 没在运行，或者手机同步没开启。ATM 关窗只是收进托盘，从托盘「完全退出」才会停                       |
| 手机提示「配对已失效」或「需要重新配对」 | 电脑上点过「重置配对」，或者 token 被撤销了。重新扫码即可                                                       |

## 自己构建 APK

不想用 Release 里的 APK，可以自己构建。需要 JDK 21（Android Studio 自带的 `jbr` 即可）和 Android SDK，在仓库根目录：

```powershell
pnpm install --frozen-lockfile
pwsh -File apps/mobile/scripts/keygen.ps1          # 第一次：生成你自己的签名密钥，放在仓库的 .local/android/
pwsh -File apps/mobile/scripts/build-release.ps1   # 产物在 .local/dist/
```

JDK 或 SDK 不在默认位置时，先设 `JAVA_HOME`、`ANDROID_HOME`。用你自己的密钥签出来的 APK 不能覆盖安装 Release 里那个，要先卸掉再装（卸载会清掉手机上的配对，重新扫码即可）。
