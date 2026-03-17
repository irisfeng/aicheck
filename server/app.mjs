import cors from "cors";
import express from "express";
import { createApiRouter } from "./api-router.mjs";

export function createApp() {
  const app = express();
  app.use(cors());
  app.use("/api", createApiRouter());
  return app;
}

export const app = createApp();
