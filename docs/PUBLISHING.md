# 维护与发布

GitHub仓库：https://github.com/560e/560-Mesh 。

## 源码发布

公开仓库只包含静态源码、补丁、模板、测试、文档与演示截图。首次发布使用干净历史，避免把内部运维提交、真实配置和私有日志推到GitHub。
每次发布前检查版本锁、补丁、文档链接、Compose语法、相关测试、许可声明与敏感信息。截图请按SCREENSHOTS.md重新使用独立演示数据生成。
源码名称不代表已有公共镜像标签；确认Docker Hub实际上传成功后再声明镜像可下载。

## 构建与发布镜像

先按DEVELOPMENT.md准备并验证源码，再显式执行Dockerfile构建。使用你实际控制的镜像仓库及版本标签，发布前做全新初始化和保留数据升级验证。
只有镜像和Release附件实际上传后，才更新README下载链接与docker pull命令。
访问Token使用GitHub/Docker提供的凭据管理，不提交代码。

已配置Docker Hub发布工作流，支持手动与v*版本标签触发；普通源码提交仍只检查。用户名放在DOCKERHUB_USERNAME仓库变量，Token放在DOCKERHUB_TOKEN仓库Secret。详细填写位置与标签规则见 [Docker Hub说明](DOCKERHUB.md)。

## 历史镜像

已交付的560-headscale-platform:1.2.0-dev.2离线包作为历史兼容版本保留，不将含内部历史资料的旧归档直接上传到公开仓库。
后续新品牌包应从清理后的源码与公开文档生成，并再次做数据与凭据排除检查。
