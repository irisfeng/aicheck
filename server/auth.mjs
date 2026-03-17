import jwt from "jsonwebtoken";

function getAuthSecret() {
  return process.env.AUTH_SECRET || process.env.JWT_SECRET || "aicheck-dev-secret";
}

export function configuredUsers() {
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

export async function createToken(user) {
  return jwt.sign(
    {
      username: user.username,
      role: user.role,
      displayName: user.displayName,
    },
    getAuthSecret(),
    {
      algorithm: "HS256",
      expiresIn: process.env.AUTH_TOKEN_TTL ?? "12h",
    },
  );
}

export async function login(username, password) {
  const user = configuredUsers().find(
    (entry) => entry.username === username && entry.password === password,
  );

  if (!user) {
    return null;
  }

  const safeUser = sanitizeUser(user);
  const token = await createToken(safeUser);
  return {
    token,
    user: safeUser,
  };
}

export async function verifyToken(token) {
  if (!token) return null;

  try {
    const payload = jwt.verify(token, getAuthSecret());
    if (
      typeof payload.username !== "string" ||
      typeof payload.role !== "string" ||
      typeof payload.displayName !== "string"
    ) {
      return null;
    }

    return {
      username: payload.username,
      role: payload.role,
      displayName: payload.displayName,
    };
  } catch {
    return null;
  }
}

export function logout() {
  return { ok: true };
}

export function readBearerToken(req) {
  const authorization = req.headers.authorization ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return "";
  }

  return authorization.slice("Bearer ".length).trim();
}

export async function requireAuth(req, res, next) {
  const token = readBearerToken(req);
  const user = await verifyToken(token);

  if (!user) {
    return res.status(401).json({
      error: "请先登录后再执行该操作。",
    });
  }

  req.auth = { token, user };
  next();
}

export function isAuthSecretConfigured() {
  return Boolean(process.env.AUTH_SECRET || process.env.JWT_SECRET);
}
