# 560-Mesh Docker组件

默认新部署入口为仓库根目录docker-compose.yml，详细步骤见 [部署说明](../docs/DEPLOYMENT.md)。
本目录保存Dockerfile、进程监督器、网关、初始化器、配置模板和运维脚本。

- docker-compose.simple.yml是直接部署模板，与根模板同类；放进新目录后填写参数。
- docker-compose.yml是维护者单服务模板，build上下文为父目录，config/data相对本目录；需要先用scripts/bootstrap.sh初始化并用scripts/admin.sh创建账号。
- 不要将这两套模板混用数据路径或直接覆盖生产YAML。
- scripts中的备份恢复工具适用于本目录单服务模板，带版本/镜像身份校验；根目录直接部署推荐按UPGRADE.md完整目录备份。

运行数据、真实配置、缓存与凭据不入库。Nginx、DNS、证书、FRP、防火墙由部署者手工维护。
