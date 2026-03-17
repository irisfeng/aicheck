import { randomUUID } from "node:crypto";

const sessionStore = new Map();

function configuredUsers() {
  return [
    {
      username: process.env.DEMO_OPERATOR_USERNAME ?? "operator",
      password: process.env.DEMO_OPERATOR_PASSWORD ?? "operator123",
      role: "operator",
      displayName: "普通上传审核员",
    },
    {
      username: process.env.DEMO_EXPERT_USERNAME ?? "expert",
      password: process.env.DEMO_EXPERT_PASSWORD ?? "expert123",
      role: "expert",
      displayName: "专家人工审核员",
    },
  ];
}

function sanitizeUser(user) {
  return {
    username: user.username,
    role: user.role,
    displayName: user.displayName,
  };
}

export function login(username, password) {
  const user = configuredUsers().find(
    (entry) => entry.username === username && entry.password === password,
  );

  if (!user) {
    return null;
  }

  const token = randomUUID();
  sessionStore.set(token, sanitizeUser(user));
  return {
    token,
    user: sanitizeUser(user),
  };
}

export function getSession(token) {
  if (!token) return null;
  return sessionStore.get(token) ?? null;
}

export function logout(token) {
  if (!token) return;
  sessionStore.delete(token);
}

export function readBearerToken(req) {
  const authorization = req.headers.authorization ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return "";
  }
  return authorization.slice("Bearer ".length).trim();
}

export function requireAuth(req, res, next) {
  const token = readBearerToken(req);
  const user = getSession(token);

  if (!user) {
    return res.status(401).json({
      error: "请先登录后再执行该操作。",
    });
  }

  req.auth = { token, user };
  next();
}
