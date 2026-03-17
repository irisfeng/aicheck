import "dotenv/config";
import express from "express";
import { createApiRouter } from "../server/api-router.mjs";

const app = express();
const apiRouter = createApiRouter();

// Vercel catch-all routes may reach the handler with or without the `/api` prefix
// depending on the function mapping. Mounting both keeps the API stable on custom domains.
app.use("/api", apiRouter);
app.use(apiRouter);

export default app;
