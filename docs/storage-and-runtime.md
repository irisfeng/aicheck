# 存储与运行机制说明

## 目的

这份文档用于回答两个最常见的问题：

1. 为什么本地仓库里没有单独的数据库初始化脚本
2. 为什么 Cloudflare R2 也没有单独的初始化脚本

同时也说明本地开发和 Vercel 线上运行的差异，便于交接和后续维护。

## 总体结构

- `DashScope / Bailian`：OCR、视觉复判、逐条审查
- `PostgreSQL / Neon`：保存案件、审核结果、人工覆盖
- `Cloudflare R2`：保存原始截图、PDF、DOCX
- `Vercel`：前端静态站点和后端 API

## 为什么没有单独的数据库脚本

当前 MVP 采用的是“应用启动自动建最小表”的方式，而不是手工执行 SQL migration。

原因：

- 首次上线更快
- 内部测试不需要先准备一套 migration 流程
- 当前数据结构还在快速迭代，先保证可用性

## 数据库当前实现

数据库逻辑在以下文件中：

- `server/storage.mjs`

启动时如果检测到 `DATABASE_URL`，系统会自动连接 PostgreSQL，并执行最小表初始化逻辑。

当前自动创建的核心表是：

- `review_cases`

表中保存的是 MVP 所需的最小数据集合：

- 案件 ID
- 案件名称
- 备注
- 创建人用户名
- 创建人角色
- 创建时间
- 更新时间
- 整份审核结果 JSON

这种设计的特点是：

- MVP 上线快
- 结果结构灵活
- 后续如果需要统计报表或复杂筛选，再拆分更细表结构

## 本地为什么看不到 SQL 文件

因为当前版本没有单独维护 `sql/init.sql` 或 migration 目录。

数据库初始化直接由应用代码完成：

- 有 `DATABASE_URL`：使用 PostgreSQL，并自动建表
- 没有 `DATABASE_URL`：退回内存存储，适合本地快速开发

这也是为什么本地开发时，即使数据库没配好，系统基础界面和流程仍然能跑。

## 为什么没有 R2 初始化脚本

Cloudflare R2 不是关系型数据库，不存在“建表”这一步。

R2 的初始化实际上分成两类：

1. 云端资源初始化
2. 应用运行时接入

### 云端资源初始化

这部分不是在代码仓库里做，而是在 Cloudflare 控制台完成：

- 创建 bucket
- 创建 API token
- 配置 CORS

这一步已经由运维/开发在 Cloudflare 页面上完成。

### 应用运行时接入

代码在以下文件中：

- `server/object-storage.mjs`
- `server/api-router.mjs`
- `src/App.tsx`

运行时流程如下：

1. 前端请求 `/api/uploads/sign`
2. 后端根据 `R2_*` 环境变量生成 presigned upload URL
3. 浏览器直接把原始文件上传到 R2
4. 前端把对象信息提交给 `/api/analyze`
5. 后端再从 R2 读取原始文件并执行分析

## 本地为什么也能上传

本地开发时支持两条路径：

### 路径 A：已配置 R2

- 前端走和线上一致的直传 R2 模式
- 更接近真实上线环境

### 路径 B：未配置 R2

- 前端自动退回普通 multipart 上传
- 便于开发时不依赖外部对象存储

所以本地没有单独的 R2 脚本，不代表没有实现，而是这部分做成了“运行时自动判断是否启用”。

## 本地开发与 Vercel 线上区别

### 本地开发

- 前端：Vite dev server
- 后端：本地 Express
- 数据库：可选 PostgreSQL，也可退回内存
- 文件上传：可走普通上传，也可走 R2

适合：

- 页面联调
- prompt 调整
- 接口调试
- 基础功能开发

### Vercel 线上

- 前端：正式构建后的静态站点
- 后端：Serverless Function
- 数据库：必须使用 PostgreSQL
- 原始文件：建议使用 R2
- 登录：必须依赖 JWT，不可依赖进程内存

适合：

- 预上线验收
- 内部真实试用
- 环境变量、数据库、R2 联调

## 当前运行时健康检查

`/api/health` 会返回以下关键状态：

- `apiConfigured`
- `databaseConfigured`
- `storage`
- `objectStorageConfigured`
- `objectStorage`

建议上线后先访问一次这个接口，确认百炼、数据库、R2 都已识别成功。

## 推荐交接顺序

### 新同事接手时

1. 先看 `README.md`
2. 再看 `docs/mvp-core-workflow.md`
3. 再看本文件，理解存储和运行机制
4. 最后检查 `.env.example` 与线上环境变量是否一致

### 上线前检查

1. `DATABASE_URL` 已配置
2. `AUTH_SECRET` 已配置
3. `R2_*` 变量已配置
4. `DASHSCOPE_API_KEY` 已配置
5. `/api/health` 状态正常

## 后续可演进方向

当前实现适合 MVP。后续如果系统进入长期稳定使用阶段，可以逐步补：

- 正式 migration 目录
- 更细粒度的数据表设计
- 原始文件元数据表
- 更完整的审计日志
- 用户表和密码管理
