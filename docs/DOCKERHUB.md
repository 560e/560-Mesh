# 发布镜像到 Docker Hub

工作流：[Publish Docker Hub image](https://github.com/560e/560-Mesh/actions/workflows/dockerhub.yml)。
文件：.github/workflows/dockerhub.yml。当前支持Linux/amd64，不创建离线部署ZIP，也不自动升级任何已运行服务器。

## 1. 准备 Docker Hub 仓库和 Token

登录Docker Hub，在自己的用户名下创建公开仓库560-mesh。
在账号设置创建具有仓库推送/写入权限的Access Token。此Token用于工作流登录，不写进源码。
Docker Hub用户名不一定与GitHub用户名相同；工作流默认发布到“Docker Hub用户名/560-mesh”。

## 2. 在 GitHub 填写用户名

打开仓库：
https://github.com/560e/560-Mesh/settings/variables/actions

路径为 Settings → Secrets and variables → Actions → Variables。
点击 New repository variable：

| 字段 | 填写 |
| --- | --- |
| Name | DOCKERHUB_USERNAME |
| Value | 你的实际Docker Hub用户名 |

这是Repository Variable，不是组织名、邮箱或GitHub访问Token。工作流将校验其格式。

## 3. 在 GitHub 填写 Token

打开：
https://github.com/560e/560-Mesh/settings/secrets/actions

切换Secrets页，点击 New repository secret：

| 字段 | 填写 |
| --- | --- |
| Name | DOCKERHUB_TOKEN |
| Secret | 刚创建的Docker Hub Access Token |

Token只填在GitHub Secret，不发到聊天、不写入YAML，也不放在Variables中。
缺少用户名或Token时，工作流在构建前停止，并提示应配置的字段。

## 4. 手动触发

1. 打开Actions → Publish Docker Hub image。
2. 点击Run workflow，选择要构建的分支或标签。
3. image_tag填写镜像标签，例如edge或1.2.0-dev.3；默认edge。
4. publish_latest默认不勾选。希望同时更新latest时才勾选。
5. 点击Run workflow开始构建、登录并推送。

如果直接将image_tag填写为latest，也必须勾选publish_latest。
完成后，工作流摘要显示完整镜像名、标签和digest。手动输入的标签只改变镜像标识，不自动修改源码版本文件。

## 5. 推送版本标签自动发布

在包含本工作流的最新源码提交上，先按发布计划更新版本和说明，再创建版本标签。下面的版本仅作示例：

~~~sh
git switch main
git pull --ff-only
git tag v1.2.0-dev.3
git push origin v1.2.0-dev.3
~~~

| Git标签或手动选项 | 上传的Docker标签 |
| --- | --- |
| v1.2.3 | 1.2.3、latest |
| v1.2.3-rc.1 | 1.2.3-rc.1 |
| 手动image_tag=edge，不勾选latest | edge |
| 手动image_tag=edge，勾选latest | edge、latest |

版本标签采用vX.Y.Z或vX.Y.Z-rc.1等格式，不含+build元数据。预发布不会自动覆盖latest。
正式版本标签都会更新latest；若需要重新构建旧版本且保留当前latest，应手动运行并不勾选latest。
普通main提交和Pull Request只运行源码检查，不触发Docker Hub构建上传。

## 6. 服务器使用上传后的镜像

确认Docker Hub中确实存在目标标签，再修改自己的Compose image，例如：

~~~yaml
image: &image "YOUR_DOCKER_ID/560-mesh:1.2.3"
~~~

将initialize与platform的pull_policy从never改为missing，以便本机没有该版本时下载，或先自行docker pull。
更新已有版本时先备份config/data，保留原域名、端口和挂载，再按升级文档切换镜像。更新Docker Hub标签不会自动替换已经运行的容器。

## 工作流行为

- 使用仓库根目录上下文与head-docker/Dockerfile；单一业务镜像。
- 先运行平台/发布参数测试，校验凭据是否配置，再登录和构建。
- Dockerfile构建中继续执行Headplane单测、类型检查和编译。
- 镜像仅发布Linux/amd64；使用GitHub Actions缓存加速后续构建。
- Token只用于预检和Docker登录，不作为Docker构建参数，不输出到摘要。
- 不连接部署服务器，不修改Nginx、DNS、FRP、防火墙或运行数据。
- 本次提交只配置流程，不主动创建版本标签或运行上传。

## 常见失败

- 找不到DOCKERHUB_USERNAME：检查是否创建在Variables页，名字完全一致。
- 找不到DOCKERHUB_TOKEN：检查Repository Secret及名字，不要放在Variables。
- unauthorized/denied：检查Token归属、写入权限、有效期，以及用户名下是否有560-mesh仓库。
- 标签无效：使用不超过128字符的Docker标签，避免空格、斜杠、换行和冒号。
- 新服务器仍使用旧镜像：确认Compose标签和pull_policy，拉取后重新up；保留数据。
