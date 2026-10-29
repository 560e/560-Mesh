# 560-Mesh 开发指南

## 目录与工具

仓库根目录包含headscale/与head-docker/，默认直接部署Compose在根目录。Node24、pnpm10、Git、Python3.11+用于开发；精确上游和镜像摘要在headscale/sources.lock.json。
应用基于React Router、TypeScript、Vite、Tailwind、Lucide图标和Motion动效。

## 准备锁定上游

~~~sh
cd headscale
node tools/sources.mjs
cd sources/headplane
corepack enable
pnpm install --frozen-lockfile
~~~

准备脚本校验锁定上游提交和完整补丁，拒绝覆盖无关改动。Headscale保持官方源码与二进制。
sources/与node_modules不提交Git。不要将正在运行的真实配置用于开发演示。

## 修改与验证

~~~sh
# 在headscale/sources/headplane中：
pnpm test:unit
pnpm typecheck
pnpm build
pnpm build:admin
pnpm build:runtime
~~~

源码修改最后导出为补丁，要求用于导出的checkout HEAD保持锁定官方提交。自己的变更留在diff；也可在独立worktree中提交，最后同步差异回锁定checkout再导出。

~~~sh
# 回到headscale目录：
node tools/export-patch.mjs
cp sources.lock.json ../head-docker/sources.lock.json
npm test
python3 -B -m unittest discover -s tests -p 'test_*.py'
node tools/check.mjs

# 回到仓库根目录：
docker compose config --quiet
~~~

初始化DNS补充测试从head-docker目录执行：
~~~sh
cd head-docker
node --test tests/initialize-dns.test.mjs
~~~

源构建使用仓库根目录上下文：
~~~sh
docker build -f head-docker/Dockerfile -t 560-mesh:local .
~~~

构建镜像或部署包必须是维护者的明确操作；日常检查CI不自动发布或部署。

## CI与贡献

GitHub Actions执行锁定源码准备、Headplane单测/类型检查、平台与运维测试、初始化DNS和Compose语法检查，不构建或推送镜像。
新增行为应覆盖重要回归条件；文案与低风险可逆修改不要求机械复制实现的测试。
保留上游许可与来源，新增功能在补丁对应上游CHANGELOG的Next段说明；不要改锁文件来掩盖补丁不一致。
