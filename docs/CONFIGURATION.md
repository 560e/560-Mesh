# 配置参考

## 根目录Compose参数

| 参数 | 默认值/格式 | 含义 |
| --- | --- | --- |
| image | 560-mesh:local | 先显式构建该镜像，或填写已导入的实际标签 |
| public_url | HTTPS域名 | 统一公开控制入口，当前初始化限定标准443，无路径 |
| admin_username | admin560 | 首次管理员；不代表存在可登录的默认账号 |
| admin_password | 占位符 | 必须修改，已有管理员不会被重置 |
| admin_port | 127.0.0.1:56011:3000 | 只改宿主端口 |
| headscale_port | 127.0.0.1:56012:8080 | 根页面和控制协议入口 |
| magic_dns | false | 仅用于首次初始化，之后在后台修改DNS |
| base_domain | 空字符串 | MagicDNS关闭时可空；开启时需独立内部域名 |

不要用新的YAML模板覆盖已有生产文件。根Compose是直接部署入口；head-docker/docker-compose.yml是维护者单服务运维模板，二者数据目录和初始化步骤不同，不混用。

## 持久化目录

| 位置 | 主要内容 |
| --- | --- |
| config/headscale | Headscale基础配置 |
| config/headplane | 管理台、会话及服务端连接配置 |
| data/headscale | 控制数据库、身份与运行时配置 |
| data/headplane | 管理员数据库、密钥保险库、网络与站点设置 |
| data/headplane/enrollment-vault.key | 已保存密钥的加密主文件 |

不要手动编辑生成的运行时覆盖文件。基础配置只读挂载，网页DNS/DERP等设置持久化于network-settings，受控生成有效运行配置。
网页已保存的覆盖字段以覆盖值为准；更改基础YAML不会自动取消覆盖。DNS不会无故替换原有分离DNS、自定义记录与搜索域。

## 网络与访问

容器3000提供管理台；8080对外提供精确根页和Headscale控制透传，8081仅为容器内控制后端。
应用内部服务端API Key不发送浏览器。不要把预认证密钥与服务器API Key混淆。
只读根文件系统、非root业务用户、有限可写数据目录和无Docker Socket是默认运行约束。不要为了修复目录权限随意开放整个挂载目录。

## 兼容名称

历史离线镜像使用560-headscale-platform:1.2.0-dev.2。内部路径、已有卷与/adminis为兼容保留，不因项目更名迁移数据。
已交付历史镜像不包含后来仅在源码完成的品牌更新。仓库当前没有承诺公开镜像仓库和自动升级通道。
