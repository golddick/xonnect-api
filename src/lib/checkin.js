const crypto = require("crypto");
const QRCode = require("qrcode");
const bcrypt = require("bcryptjs");
const prisma = require("./prisma");
const { dropid } = require("dropid");

const COOKIE_NAME = "xonnect_checkin_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const CAMERA_TTL_MINUTES = 30;

function secret() {
  const value = process.env.AUTH_LOGIN_TOKEN_SECRET || process.env.NEXTAUTH_SECRET || process.env.JWT_SECRET;
  if (!value) throw new Error("Missing check-in session secret");
  return value;
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64").toString("utf8");
}

function createSessionToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    userId: user.id,
    email: user.email,
    username: user.username,
    fullName: user.fullName,
    eventId: user.eventId,
    gateName: user.gateName,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", secret()).update(encoded).digest();
  return `${encoded}.${base64UrlEncode(signature)}`;
}

function verifySessionToken(token) {
  try {
    const [payloadPart, signaturePart] = String(token || "").split(".");
    if (!payloadPart || !signaturePart) return null;
    const expected = crypto.createHmac("sha256", secret()).update(payloadPart).digest();
    const received = Buffer.from(signaturePart.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
    const payload = JSON.parse(base64UrlDecode(payloadPart));
    return payload.exp < Math.floor(Date.now() / 1000) ? null : payload;
  } catch {
    return null;
  }
}

function getCookie(req, name) {
  const header = req.headers.cookie || "";
  const prefix = `${name}=`;
  const item = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : null;
}

function serializeUser(user) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    fullName: user.fullName,
    gateName: user.gateName,
    status: user.status,
    scansToday: user.scansToday,
    totalScans: user.totalScans,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    event: {
      id: user.event.id,
      title: user.event.title,
      status: user.event.status,
      scheduledAt: user.event.scheduledAt ? user.event.scheduledAt.toISOString() : null,
      accessType: user.event.requireTicket ? "ticketed" : "open",
      isHybrid: user.event.tickets.some((ticket) => ticket.access === "VENUE") && user.event.tickets.some((ticket) => ticket.access === "STREAM"),
    },
  };
}

async function loadUser(id) {
  const user = await prisma.creatorEventCheckInUser.findUnique({
    where: { id },
    include: { event: { include: { tickets: true } } },
  });
  return user && user.status === "ACTIVE" ? user : null;
}

async function getAuthenticatedUser(req) {
  const token = getCookie(req, COOKIE_NAME);
  const payload = verifySessionToken(token);
  if (!payload) return null;
  const user = await loadUser(payload.userId);
  return user ? serializeUser(user) : null;
}

function hashCameraToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createCameraToken() {
  const token = crypto.randomBytes(24).toString("base64url");
  return { token, tokenHash: hashCameraToken(token), tokenPrefix: token.slice(0, 8) };
}

function normalizeCameraStatus(status) {
  return String(status || "ACTIVE").toUpperCase();
}

function activeCameraStatus(status) {
  return ["ACTIVE", "OPENED", "CONNECTED"].includes(normalizeCameraStatus(status));
}

function cameraUrl(token) {
  return `${process.env.NEXT_PUBLIC_APP_URL || process.env.APP_BASE_URL || "http://localhost:3000"}/checkin/camera/${token}`;
}

async function cameraQrDataUrl(token) {
  return QRCode.toDataURL(cameraUrl(token), { errorCorrectionLevel: "H", margin: 1, width: 320 });
}

function parsePayload(code) {
  const parsed = {};
  for (const segment of String(code || "").trim().split("|")) {
    const [key, ...rest] = segment.split(":");
    if (key && rest.length) parsed[key.trim().toLowerCase()] = rest.join(":").trim();
  }
  return {
    ticketCode: parsed.code || parsed.ticket || String(code || "").trim(),
    purchaseId: parsed.purchase || null,
    eventId: parsed.event || null,
  };
}

async function findVenueTicket(eventId, parsed) {
  const ticketItem = await prisma.creatorEventTicketItem.findFirst({
    where: { ticketCode: parsed.ticketCode, ticket: { eventId, access: "VENUE" } },
    include: { purchase: { include: { ticket: true } } },
  });
  const purchase = ticketItem?.purchase || await prisma.creatorEventTicketPurchase.findFirst({
    where: {
      OR: [{ ticketCode: parsed.ticketCode }, ...(parsed.purchaseId ? [{ id: parsed.purchaseId }] : [])],
      ticket: { eventId, access: "VENUE" },
    },
    include: { ticket: true },
  });
  return { ticketItem, purchase };
}

async function loadDashboard(userId) {
  const user = await prisma.creatorEventCheckInUser.findUnique({
    where: { id: userId },
    include: {
      event: {
        include: {
          tickets: true,
          checkInScans: { orderBy: { scannedAt: "desc" }, take: 12, include: { ticketPurchase: { include: { ticket: true } } } },
        },
      },
    },
  });
  if (!user) return null;
  const venueTickets = user.event.tickets.filter((ticket) => ticket.access === "VENUE");
  const streamingTickets = user.event.tickets.filter((ticket) => ticket.access === "STREAM");
  return {
    user: serializeUser(user),
    stats: {
      totalScans: user.totalScans,
      scansToday: user.scansToday,
      venueTickets: venueTickets.length,
      checkedInPurchases: user.event.checkInScans.filter((scan) => scan.status === "SUCCESS").length,
    },
    recentScans: user.event.checkInScans.map((scan) => ({
      id: scan.id,
      attendeeName: scan.attendeeName || scan.ticketPurchase?.buyerName || null,
      attendeeEmail: scan.attendeeEmail || scan.ticketPurchase?.buyerEmail || null,
      gateName: scan.gateName || user.gateName,
      status: scan.status,
      scannedAt: scan.scannedAt.toISOString(),
      code: scan.scannedCode || scan.ticketPurchase?.ticketCode || "",
      ticketType: scan.ticketPurchase?.ticket?.ticketType || null,
    })),
    event: { venueTicketCount: venueTickets.length, streamingTicketCount: streamingTickets.length, isHybrid: venueTickets.length > 0 && streamingTickets.length > 0 },
  };
}

module.exports = {
  COOKIE_NAME,
  createSessionToken,
  verifySessionToken,
  getAuthenticatedUser,
  serializeUser,
  getCookie,
  createCameraToken,
  hashCameraToken,
  activeCameraStatus,
  normalizeCameraStatus,
  cameraUrl,
  cameraQrDataUrl,
  parsePayload,
  findVenueTicket,
  loadDashboard,
  loadUser,
  prisma,
  bcrypt,
  dropid,
  CAMERA_TTL_MINUTES,
};
