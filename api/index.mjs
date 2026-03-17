import "dotenv/config";
import express from "express";
import { createApiRouter } from "../server/api-router.mjs";

const app = express();
app.use(createApiRouter());

export default app;
