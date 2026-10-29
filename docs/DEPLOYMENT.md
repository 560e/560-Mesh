# 560-Mesh 部署说明

## 环境

验证环境为 Linux x86_64 / amd64。需要 Docker Engine、Docker Compose V2、Git；源码构建需要网络与足够磁盘。其他架构尚未完成组合镜像验收。
公开域名使用 HTTPS，由部署者准备 DNS、证书和反代。应用不配置宿主 Nginx、防火墙、FRP 或其他服务。

## 1. 构建源码镜像

~~~sh
git clone https://github.com/560e/560-Mesh.git
cd 560-Mesh
docker build -f head-docker/Dockerfile -t 560-mesh:local .
~~~

保持仓库结构完整；Dockerfile 的构建上下文必须是仓库根目录。
构建会校验上游与补丁，运行单元/类型检查并编译应用。不会向镜像仓库推送。
此命令供部署者显式执行；此次源码公开没有重新构建或上传部署包。

如已经持有维护者提供的历史镜像 tar，可先 docker load -i 实际文件.tar，再在 YAML 中填写 docker image ls 显示的实际标签。不存在的标签不能直接拉取。历史镜像可能仍显示旧品牌。

## 2. 修改根目录 docker-compose.yml

只需填写顶部 x-settings：

~~~yaml
x-settings:
  image: &image "560-mesh:local"
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

独立命令形式为 docker-compose。
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
