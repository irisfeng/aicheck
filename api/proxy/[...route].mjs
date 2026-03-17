import "dotenv/config";
import express from "express";
import { createApiRouter } from "../../server/api-router.mjs";

const app = express();
const apiRouter = createApiRouter();

app.use("/api/proxy", apiRouter);
app.use(apiRouter);

export default app;
