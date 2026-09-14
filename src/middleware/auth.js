const prisma = require("../lib/prisma");
const { verifyAuthToken } = require("../utils/tokens");

// Wraps async route handlers so thrown errors reach the error middleware.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Requires a valid Bearer token, attaches req.user (Profile) and req.creator (if any).
const requireAuth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  let payload;
  try {
    payload = verifyAuthToken(token);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  const profile = await prisma.profile.findUnique({
    where: { id: payload.sub },
    include: { creator: true },
  });

  if (!profile) {
    return res.status(401).json({ error: "Account no longer exists" });
  }

  req.user = profile;
  req.creator = profile.creator;
  next();
});

// Populates req.user if a valid token is present, but doesn't reject the request otherwise.
const optionalAuth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next();

  try {
    const payload = verifyAuthToken(token);
    const profile = await prisma.profile.findUnique({
      where: { id: payload.sub },
      include: { creator: true },
    });
    if (profile) {
      req.user = profile;
      req.creator = profile.creator;
    }
  } catch {
    // ignore invalid/expired token for optional auth
  }
  next();
});

const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "You do not have permission to do that" });
    }
    next();
  };

// Ensures the caller has an active Creator profile (req.creator).
const requireCreator = (req, res, next) => {
  if (!req.creator) {
    return res.status(403).json({ error: "This action requires a creator account" });
  }
  next();
};

module.exports = { asyncHandler, requireAuth, optionalAuth, requireRole, requireCreator };
