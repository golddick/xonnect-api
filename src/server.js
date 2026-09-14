require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const { notFound, errorHandler } = require("./middleware/errorHandler");

const authRoutes = require("./routes/auth.routes");
const profileRoutes = require("./routes/profile.routes");
const creatorsRoutes = require("./routes/creators.routes");
const eventsRoutes = require("./routes/events.routes");
const ticketsRoutes = require("./routes/tickets.routes");
const checkinRoutes = require("./routes/checkin.routes");
const videosRoutes = require("./routes/videos.routes");
const payoutsRoutes = require("./routes/payouts.routes");
const categoriesRoutes = require("./routes/categories.routes");
const uploadsRoutes = require("./routes/uploads.routes");
const paymentsRoutes = require("./routes/payments.routes");
const livestreamRoutes = require("./routes/livestream.routes");
const communityRoutes = require("./routes/community.routes");

const app = express();

app.use(helmet());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// IMPORTANT: the Paystack webhook needs the raw request body to verify the
// x-paystack-signature header, so it's mounted with express.raw() BEFORE the
// global express.json() parser below. Every other route gets normal JSON parsing.
app.use("/api/payments/paystack/webhook", express.raw({ type: "*/*" }));
app.use((req, res, next) => {
  if (req.originalUrl === "/api/payments/paystack/webhook") return next();
  express.json({ limit: "5mb" })(req, res, next);
});

const allowedOrigins = (process.env.CORS_ORIGIN || "*").split(",").map((s) => s.trim());
app.use(
  cors({
    origin: allowedOrigins.includes("*") ? true : allowedOrigins,
    credentials: true,
  })
);

// Basic rate limiting on auth endpoints to slow down brute-force attempts.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50 });
app.use("/api/auth", authLimiter);

app.get("/health", (req, res) => res.json({ ok: true, service: "xonnect-api", time: new Date().toISOString() }));

// Routes — mounted to mirror the app's domains: xonnect.net/api/...
app.use("/api/auth", authRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/creators", creatorsRoutes);
app.use("/api/events", eventsRoutes);
app.use("/api/events", livestreamRoutes); // adds /api/events/:id/livestream/*
// ticketsRoutes defines its own full paths: /events/:eventId/tickets and /tickets/:ticketId, /tickets/:ticketId/purchase/initialize, /tickets/purchases/:code
app.use("/api", ticketsRoutes);
app.use("/api/checkin", checkinRoutes);
app.use("/api/videos", videosRoutes);
app.use("/api/payouts", payoutsRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/uploads", uploadsRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/community", communityRoutes);

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`xonnect-api listening on http://localhost:${PORT}`);
});

module.exports = app;
