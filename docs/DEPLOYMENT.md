# 560-Mesh 部署说明

## 环境

Linux x86_64 / amd64，已安装并运行Docker Engine与Docker Compose V2，能访问Docker Hub。
默认镜像为zhangxw560/560-mesh:edge，Compose会自动拉取，无需Git、源码或本地编译。其他架构尚未完成组合镜像验收。
公开域名使用HTTPS；DNS、证书和反代由部署者手工准备。应用不配置宿主Nginx、防火墙、FRP或其他服务。

## 1. 下载Compose文件

在新服务器的空项目目录中保存仓库根目录docker-compose.yml。可以在GitHub下载，也可以运行：

~~~sh
mkdir -p 560-Mesh
cd 560-Mesh
curl -fL https://raw.githubusercontent.com/560e/560-Mesh/main/docker-compose.yml -o docker-compose.yml
~~~

后续操作都在此目录进行。这个单独YAML已包含初始化逻辑，不需要额外脚本或配置模板；容器会创建config/data。
已有部署升级不要使用下载命令覆盖原YAML，请按 [升级说明](UPGRADE.md) 保留原配置和数据。

## 2. 修改根目录 docker-compose.yml

默认镜像已填写，只需修改顶部x-settings的域名、管理员账号密码和两个宿主端口：

~~~yaml
x-settings:
  image: &image "zhangxw560/560-mesh:edge"
  public_url: &public_url "https://mesh.example.com"
  magic_dns: &magic_dns "false"
  base_domain: &base_domain ""
  admin_username: &admin_username "admin560"
  admin_password: &admin_password "CHANGE_ME_BEFORE_START"
  admin_port: &admin_port "127.0.0.1:56011:3000"
  headscale_port: &headscale_port "127.0.0.1:56012:8080"
~~~

- public_url：实际 HTTPS 域名，不带管理路径、查询或后端端口；当前初始化校验限定标准443入口。
- admin_password：替换占位符，12–128字符，UTF-8不超过512字节。一个字面美元符号在Compose YAML中写成 $$。
- admin_username：3–32位，以字母开头，只含字母、数字、_.-，自动转小写。
- 两个端口：只修改中间的宿主端口，保留容器3000/8080。不能相同，也不能占用已有服务端口。
- magic_dns：新部署默认false，base_domain可为空。若启用，设置独立内部域名，不能等于或覆盖公开域名。

配置文件可能含初始密码，请限制访问，不提交真实 YAML 到 GitHub。多套部署使用不同目录、name、域名和宿主端口。

## 3. 启动

~~~sh
docker compose up -d
docker compose ps -a
docker compose logs --tail=80 initialize
docker compose logs --tail=100 platform
~~~

独立命令形式为docker-compose。两个服务的pull_policy均为missing：本机没有该镜像时自动下载，不需要先docker load或docker build。
initialize 以有限权限准备目录、生成配置并创建管理员，完成后 Exited(0) 正常；platform 是唯一长期运行业务容器。
真实config/data生成在根目录。再次启动保留已有管理员密码，修改YAML密码不会重置已有账号。
直接Compose方式不读取SHA清单，也不需要额外参数文件。

## 4. 手工配置HTTPS反代

按默认端口配置宝塔高级反代：

| 字段 | 下载首页与控制服务 | 管理台 |
| --- | --- | --- |
| 代理目录 | / | /adminis/ |
| 目标URL | http://127.0.0.1:56012 | http://127.0.0.1:56011/adminis |
| 发送域名 | mesh.example.com | mesh.example.com |
| 缓存 | 关闭 | 关闭 |

将域名与端口替换为实际值。面板修改目标URL后可能把“发送域名”填回127.0.0.1，应再次检查。
反代需保留Host、HTTP Upgrade和相关控制路径，关闭不适用的缓冲；证书和超时由你维护。
同机云服务器直接反代到回环端口，不需要FRP。容器内部8081不映射到宿主。

## 5. 验收

1. platform健康，initialize退出0。
2. HTTPS根页面显示客户端下载与教程。
3. /adminis/能够登录，设置页显示控制服务连接正常。
4. 创建一个测试用户和接入配置，在自己的测试设备执行生成命令。
5. 通过实际设备验证组网IP、用户隔离和路由；确认备份方案。

公网入口配置错误不能通过重置数据库解决。排错见 [故障排查](TROUBLESHOOTING.md)。

## 更新edge镜像

edge是可更新标签。已有同名本地镜像时，单独up不会强制下载新版本。维护窗口先按升级文档备份，再运行：

~~~sh
docker compose pull
docker compose up -d
docker compose ps -a
~~~

保留原域名、端口、账号、项目名和config/data。需要固定版本时，改用Docker Hub中实际存在的版本标签或摘要。
源码构建仅供开发者选择，见 [开发指南](DEVELOPMENT.md)；普通部署不需要构建环境。
