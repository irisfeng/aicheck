import "dotenv/config";
import express from "express";
import { createApiRouter } from "../server/api-router.mjs";

function buildRewrittenUrl(req) {
  const rawRoute = req.query?.route;
  const route = Array.isArray(rawRoute) ? rawRoute.join("/") : String(rawRoute || "").trim();

  if (!route) {
    return req.url;
  }

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (key === "route") continue;
    if (Array.isArray(value)) {
      value.forEach((entry) => query.append(key, String(entry)));
    } else if (value !== undefined) {
      query.append(key, String(value));
    }
  }

  const normalizedPath = `/${route.replace(/^\/+/, "")}`;
  const search = query.toString();
  return search ? `${normalizedPath}?${search}` : normalizedPath;
}

const app = express();
app.use((req, _res, next) => {
  req.url = buildRewrittenUrl(req);
  next();
});
app.use(createApiRouter());

export default app;
