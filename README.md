# 560-Mesh

**让设备互联，让管理简单。**

基于 [Headscale](https://github.com/juanfont/headscale) 与 [Headplane](https://github.com/tale/headplane) 的自托管组网管理平台。提供中文控制台、按用户分组的设备工作台、可复用的设备接入命令，以及 Docker Compose 部署。

[快速部署](docs/DEPLOYMENT.md) · [使用教程](docs/USER-GUIDE.md) · [配置参考](docs/CONFIGURATION.md) · [升级备份](docs/UPGRADE.md) · [开发指南](docs/DEVELOPMENT.md) · [常见问题](docs/TROUBLESHOOTING.md)

## 界面预览

以下均为当前源码的真实界面截图。账号、设备和网络来自独立演示环境；未使用生产数据，未展示有效密钥或实际服务器地址。点击图片查看原图。

| 公开客户端下载首页 | 管理员登录 |
| --- | --- |
| [![客户端下载首页](docs/images/public-home.jpg)](docs/images/public-home.jpg) | [![管理员登录](docs/images/admin-login.jpg)](docs/images/admin-login.jpg) |

| 按用户分组的设备工作台 | 系统设置与多 DERP |
| --- | --- |
| [![设备工作台](docs/images/devices-cards.jpg)](docs/images/devices-cards.jpg) | [![多 DERP 设置](docs/images/settings-derp.jpg)](docs/images/settings-derp.jpg) |

[查看列表视图、接入表单与更多截图](docs/SCREENSHOTS.md)。

## 主要功能

| 模块 | 功能 |
| --- | --- |
| 设备工作台 | 按用户分组、搜索、折叠，支持列表和卡片视图 |
| 统一设备接入 | 集中管理接入配置、通用加入命令与预认证密钥 |
| 命令生成 | DNS、子网路由、出口节点、强制重新认证等客户端选项 |
| 选项记忆 | 记住当前浏览器、服务器和管理员上次成功创建时的选项 |
| 密钥管理 | 保存可再次查看的完整密钥，支持删除；新建可复用密钥默认999天 |
| 用户隔离与互通 | 符合条件的默认策略启用隔离，可选择参与互通的用户 |
| DERP | 官方中继与最多16个自建 DERP，逐项检测、独立 STUN，HTTPS端口可省略 |
| 系统设置 | DNS、访问控制、DERP、账号安全和公开首页标题 |
| 下载与教程 | 官方稳定版客户端下载入口、带图标的三步接入教程 |
| 部署 | 单一业务镜像；一次性 initialize 完成后退出，platform 持续运行 |

新建接入配置默认不接收服务器 DNS；发布空白子网列表时建议 192.168.0.0/24。
客户端优先尝试建立直连，无法直连时使用可用 DERP。控制台不会把未知连接状态标为直连。

## 快速开始

当前仓库发布的是源码。**尚未提供可从 Docker Hub/GHCR 拉取的 560-mesh 镜像；请先构建本地镜像。** 本仓库不自动构建或发布部署包。

环境：Linux x86_64 / amd64、已运行的 Docker Engine、Docker Compose V2，以及 Git。完整构建需要网络访问锁定的上游与依赖。

~~~sh
git clone https://github.com/560e/560-Mesh.git
cd 560-Mesh
docker build -f head-docker/Dockerfile -t 560-mesh:local .
~~~

打开根目录 docker-compose.yml，修改顶部 x-settings 的 public_url、管理员账号密码和宿主端口，然后运行：

~~~sh
docker compose up -d
docker compose ps -a
~~~

使用独立命令的系统可改为 docker-compose up -d。
initialize 退出0属于正常完成；platform 应持续运行并变为 healthy。
新安装没有可使用的默认密码，必须替换 CHANGE_ME_BEFORE_START。

配置有效 HTTPS 与手工反代后：
- 下载首页与控制入口：https://你的域名/
- 管理台：https://你的域名/adminis/

详细步骤及手工反代字段见 [部署说明](docs/DEPLOYMENT.md)。项目不改动 Nginx、FRP、DNS、防火墙或其他项目，也不占用宿主80/443。

## 端口与数据

| 入口 | 模板宿主监听 | 容器端口 |
| --- | --- | --- |
| 管理台 | 127.0.0.1:56011 | 3000 |
| 下载首页 / Headscale协议 | 127.0.0.1:56012 | 8080 |

两个宿主端口均可在 YAML 修改；容器端口保留。容器内8081无需发布。
config/ 与 data/ 是持久目录。数据库与 enrollment-vault.key 必须一起备份。不要将整个部署目录作为公开静态站点。

## 文档

- [部署与宝塔反代](docs/DEPLOYMENT.md)
- [用户、接入命令、路由和 DERP 使用教程](docs/USER-GUIDE.md)
- [配置项与默认值](docs/CONFIGURATION.md)
- [备份、迁移、升级及回退](docs/UPGRADE.md)
- [架构与数据流](docs/ARCHITECTURE.md)
- [源码开发与验证](docs/DEVELOPMENT.md)
- [故障排查](docs/TROUBLESHOOTING.md)
- [截图说明与隐私处理](docs/SCREENSHOTS.md)

## 技术与上游

Headscale 基线为官方0.29.6，Headplane 基线为0.8.2。具体提交、镜像摘要与补丁校验见 headscale/sources.lock.json。Headscale 使用官方未修改二进制；Headplane 修改以完整补丁维护。Tailscale 客户端使用官方应用。

560-Mesh 是独立衍生项目，与上游不存在官方隶属关系。新名称下的源码不意味着历史离线镜像已自动更名；已持有历史1.2.0-dev.2包的用户请按升级文档保留兼容标签。

## 贡献与许可

欢迎通过 [Issues](https://github.com/560e/560-Mesh/issues) 与 Pull Request 参与。请先阅读 [贡献指南](CONTRIBUTING.md)，安全问题见 [SECURITY.md](SECURITY.md)。

560-Mesh 自有新增代码采用 [MIT License](LICENSE)。上游和第三方组件遵循各自许可，原始声明保存在 [许可目录](headscale/LICENSES/NOTICE.md)。感谢 Headscale、Headplane、Tailscale 及其贡献者。
