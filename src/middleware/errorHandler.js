const { ZodError } = require("zod");
const { Prisma } = require("../generated/prisma");

function notFound(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "Validation failed",
      details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: `Already exists (${err.meta?.target || "unique field"})` });
    }
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Record not found" });
    }
    if (err.code === "P2003") {
      return res.status(400).json({ error: "Related record not found" });
    }
  }

  if (err instanceof Prisma.PrismaClientInitializationError) {
    console.error("Prisma database initialization failed:", err.message);
    return res.status(503).json({ error: "Database unavailable" });
  }

  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.publicMessage || "Something went wrong" });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.publicMessage = message;
  }
}

module.exports = { notFound, errorHandler, HttpError };
