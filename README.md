# 语音业务对接入网技术审核台

内部使用的 AI 辅助审核 MVP。

## 当前能力

- 两类账号：普通上传审核、专家人工审核
- 上传截图、PDF、DOCX、TXT、MD、JSON
- 根据文件名前缀自动归档审查项
- 调用百炼完成 OCR、逐条审查和必须项视觉复判
- 专家人工覆盖结论
- 持久化保存案件与历史结果

## 推荐命名

- `2.8.1.1.png`
- `2.8.1.1-1.png`
- `2.8.1.1-2.png`
- `2.8.2.3-1-IP白名单.png`
- `安扫报告.pdf`

系统会优先按审查项编号归档；类似 `安扫报告` 的文件会作为全局材料参与审查。

## 本地开发

1. 复制 `.env.example` 为 `.env`
2. 填写 `DASHSCOPE_API_KEY`
3. 可选填写 `AUTH_SECRET`
4. 如果要本地连云数据库，再填写 `DATABASE_URL`
5. 安装依赖：

```bash
npm install
```

6. 启动：

```bash
npm run dev
```

7. 打开 `http://localhost:5173`

## 环境变量

- `DASHSCOPE_API_KEY`
- `DASHSCOPE_BASE_URL`
- `DASHSCOPE_OCR_MODEL`
- `DASHSCOPE_SUMMARY_MODEL`
- `DASHSCOPE_VISION_MODEL`
- `DASHSCOPE_ENABLE_MANDATORY_VISION_RECHECK`
- `DASHSCOPE_MANDATORY_VISION_MAX_IMAGES`
- `AUTH_SECRET`
- `DATABASE_URL`
- `PGSSLMODE`
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`
- `R2_ENDPOINT`
- `R2_PRESIGN_EXPIRES_SECONDS`
- `DEMO_OPERATOR_USERNAME`
- `DEMO_OPERATOR_PASSWORD`
- `DEMO_EXPERT_USERNAME`
- `DEMO_EXPERT_PASSWORD`

## 存储策略

- 本地未配置 `DATABASE_URL` 时：
  使用内存存储，适合开发验证
- 配置 `DATABASE_URL` 后：
  自动启用 PostgreSQL，适合 Vercel + Neon / 其他云 PostgreSQL

## 原始文件存储

当前推荐：

- `Neon / PostgreSQL` 保存案件、审查结果、OCR 文本和人工覆盖
- `Cloudflare R2` 保存原始截图、PDF、DOCX

上传链路已经调整为：

1. 前端请求后端生成 R2 直传地址
2. 浏览器直接上传到 R2
3. 后端再根据对象 key 从 R2 拉取原始文件并执行分析

如果本地未配置 R2，前端会自动回退到开发模式下的普通上传。

## Vercel 部署

当前仓库已经补齐了最小 Vercel 适配：

- 前端继续使用 Vite 构建
- 后端通过 `api/index.mjs` 暴露给 Vercel
- 登录已改为 JWT，无需依赖进程内存会话
- 案件结果可保存到 PostgreSQL

推荐生产形态：

- Vercel
- Neon Postgres 或其他云 PostgreSQL
- 百炼 API

## 审查工作机制

1. 上传按编号命名的截图和报告
2. OCR 抽取文本
3. 必须项命中截图时做视觉复判
4. AI 逐条给出依据、整改项和参考做法
5. 专家人工覆盖并保存最终结果

## 说明

- `memory/` 目录按日期记录每日开发进度
- 当前仍是 MVP，优先保证内部测试可用，不追求过度复杂化
