# 语音业务对接入网技术审核台

内部使用的 AI 辅助审核 MVP。

## 当前能力

- 两类账号：普通上传审核、专家人工审核
- 上传图片、PDF、DOCX、TXT、MD、JSON
- 按文件名前缀自动归档到对应审查项
- 调用百炼完成 OCR、逐条审查和必须项视觉复判
- 专家人工覆盖结论并导出结果
- 支持案件结果持久化保存

## 推荐命名

- `2.8.1.1.png`
- `2.8.1.1-1.png`
- `2.8.1.1-2.png`
- `2.8.2.3-1-IP白名单.png`
- `安扫报告.pdf`

系统会优先按审查项编号归档；类似 `安扫报告` 的文件会作为全局材料参与审查。

## 本地启动

1. 复制 `.env.example` 为 `.env`
2. 填写 `DASHSCOPE_API_KEY`
3. 按需填写 `AUTH_SECRET`
4. 如果要连接云数据库，再填写 `DATABASE_URL`
5. 安装依赖

```bash
npm install
```

6. 启动开发环境

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

## 交接文档

- [MVP 工作流](./docs/mvp-core-workflow.md)
- [存储与运行机制说明](./docs/storage-and-runtime.md)
- [整体方案说明](./docs/ai-auto-audit-solution.md)

## 审查工作机制

1. 上传按编号命名的截图和报告
2. 系统执行 OCR 抽取和证据归档
3. 必须项命中截图时触发视觉复判
4. AI 逐条输出依据、整改项和参考做法
5. 专家人工覆盖并保存最终结果

## 说明

- `memory/` 目录按日期记录每日开发进度
- 当前仍是 MVP，优先保证内部测试可用，不追求过度复杂化
