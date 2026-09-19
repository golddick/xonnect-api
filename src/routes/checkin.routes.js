const express = require("express");
const { z } = require("zod");
const {
  COOKIE_NAME,
  createSessionToken,
  getAuthenticatedUser,
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
} = require("../lib/checkin");
const { asyncHandler } = require("../middleware/auth");

const router = express.Router();

function setSessionCookie(res, token, maxAge = 12 * 60 * 60) {
  const attributes = ["HttpOnly", "Path=/", `Max-Age=${maxAge}`];
  attributes.push(process.env.NODE_ENV === "production" ? "SameSite=None" : "SameSite=Lax");
  if (process.env.NODE_ENV === "production") attributes.push("Secure");
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(token)}; ${attributes.join("; ")}`);
}

function serializeCameraSession(session) {
  const iso = (value) => (value ? new Date(value).toISOString() : null);
  return {
    id: session.id,
    tokenPrefix: session.tokenPrefix,
    status: normalizeCameraStatus(session.status),
    expiresAt: iso(session.expiresAt),
    openedAt: iso(session.openedAt),
    connectedAt: iso(session.connectedAt),
    completedAt: iso(session.completedAt),
    revokedAt: iso(session.revokedAt),
    lastSeenAt: iso(session.lastSeenAt),
    clientLabel: session.clientLabel || null,
    event: { id: session.event.id, title: session.event.title, status: session.event.status },
    operator: {
      id: session.operatorUser.id,
      fullName: session.operatorUser.fullName,
      username: session.operatorUser.username,
      gateName: session.operatorUser.gateName,
    },
  };
}

async function loadCameraSession(token) {
  const session = await prisma.creatorEventCheckInCameraSession.findUnique({
    where: { tokenHash: hashCameraToken(token) },
    include: { event: true, operatorUser: true, signals: { orderBy: { createdAt: "asc" } } },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now() && !["EXPIRED", "COMPLETED"].includes(normalizeCameraStatus(session.status))) {
    return prisma.creatorEventCheckInCameraSession.update({
      where: { id: session.id },
      data: { status: "EXPIRED", revokedAt: new Date() },
      include: { event: true, operatorUser: true, signals: { orderBy: { createdAt: "asc" } } },
    });
  }
  return session;
}

function serializeSignals(signals, after) {
  return signals
    .filter((signal) => !after || signal.createdAt.getTime() > new Date(after).getTime())
    .map((signal) => ({ id: signal.id, sender: signal.sender, type: signal.type, payload: signal.payload, createdAt: signal.createdAt.toISOString() }));
}

async function getCameraActor(req, token) {
  const session = await loadCameraSession(token);
  if (!session || !activeCameraStatus(session.status) || session.operatorUser.status !== "ACTIVE") return null;
  return loadUser(session.operatorUserId);
}

router.post("/login", asyncHandler(async (req, res) => {
  const { username, password } = z.object({ username: z.string(), password: z.string() }).parse(req.body);
  const normalized = username.trim().toLowerCase();
  const user = await prisma.creatorEventCheckInUser.findFirst({
    where: { OR: [{ username: normalized }, { email: normalized }] },
    include: { event: { include: { tickets: true } } },
  });
  if (!user || user.status !== "ACTIVE" || !(await bcrypt.compare(password.trim(), user.passwordHash))) {
    return res.status(401).json({ message: "Invalid credentials" });
  }
  await prisma.creatorEventCheckInUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  setSessionCookie(res, createSessionToken(user));
  res.json({ message: "Signed in", user: { id: user.id, email: user.email, username: user.username, fullName: user.fullName, gateName: user.gateName, event: { id: user.event.id, title: user.event.title } } });
}));

router.get("/session", asyncHandler(async (req, res) => {
  const user = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });
  const dashboard = await loadDashboard(user.id);
  if (!dashboard) return res.status(404).json({ message: "Check-in session not found" });
  res.json(dashboard);
}));

router.post("/logout", (req, res) => {
  setSessionCookie(res, "", 0);
  res.json({ message: "Signed out" });
});

async function resolveActor(req, cameraToken) {
  return (await getAuthenticatedUser(req)) || (cameraToken ? getCameraActor(req, cameraToken) : null);
}

router.post("/scan", asyncHandler(async (req, res) => {
  const body = req.body || {};
  const actor = await resolveActor(req, body.cameraToken);
  if (!actor) return res.status(401).json({ message: "Unauthorized" });
  const rawCode = String(body.code || "").trim();
  if (!rawCode) return res.status(400).json({ message: "Ticket code is required" });

  const { ticketItem, purchase } = await findVenueTicket(actor.event.id, parsePayload(rawCode));
  if (!purchase) {
    await prisma.creatorEventCheckInScan.create({ data: { id: dropid("checkInScan"), eventId: actor.event.id, checkInUserId: actor.id, gateName: actor.gateName, scannedCode: parsePayload(rawCode).ticketCode, status: "INVALID", notes: "Ticket not found or not valid for this event" } });
    return res.status(404).json({ status: "invalid", message: "Ticket not found" });
  }

  const duplicate = ticketItem?.checkedInAt || (purchase.quantity === 1 && purchase.checkedInAt);
  const code = ticketItem?.ticketCode || purchase.ticketCode;
  if (duplicate) {
    await prisma.creatorEventCheckInScan.create({ data: { id: dropid("checkInScan"), eventId: actor.event.id, checkInUserId: actor.id, ticketPurchaseId: purchase.id, attendeeEmail: purchase.buyerEmail, attendeeName: purchase.buyerName, gateName: actor.gateName, scannedCode: code, status: "DUPLICATE", notes: ticketItem ? "Ticket already checked in" : "Purchase already checked in" } });
    return res.json({ status: "already", message: "Ticket already checked in", attendeeName: purchase.buyerName, ticketCode: code });
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    if (ticketItem) await tx.creatorEventTicketItem.update({ where: { id: ticketItem.id }, data: { checkedInAt: now, checkedInByUserId: actor.id } });
    else await tx.creatorEventTicketPurchase.update({ where: { id: purchase.id }, data: { checkedInAt: now, checkedInByUserId: actor.id } });
    await tx.creatorEventCheckInScan.create({ data: { id: dropid("checkInScan"), eventId: actor.event.id, checkInUserId: actor.id, ticketPurchaseId: purchase.id, attendeeEmail: purchase.buyerEmail, attendeeName: purchase.buyerName, gateName: actor.gateName, scannedCode: code, status: "SUCCESS", notes: purchase.ticket.ticketType } });
  });
  const current = await prisma.creatorEventCheckInUser.findUnique({ where: { id: actor.id }, select: { lastScanAt: true } });
  await prisma.creatorEventCheckInUser.update({ where: { id: actor.id }, data: { scansToday: current?.lastScanAt && current.lastScanAt.toDateString() === now.toDateString() ? { increment: 1 } : 1, totalScans: { increment: 1 }, lastScanAt: now } });
  res.json({ status: "success", message: "Ticket checked in", attendeeName: purchase.buyerName, attendeeEmail: purchase.buyerEmail, ticketCode: code, ticketType: purchase.ticket.ticketType, access: purchase.ticket.access });
}));

router.post("/lookup", asyncHandler(async (req, res) => {
  const body = req.body || {};
  const actor = await resolveActor(req, body.cameraToken);
  if (!actor) return res.status(401).json({ message: "Unauthorized" });
  const code = String(body.code || "").trim();
  if (!code) return res.status(400).json({ message: "Ticket code is required" });
  const { ticketItem, purchase } = await findVenueTicket(actor.event.id, parsePayload(code));
  if (!purchase) return res.json({ status: "invalid", message: "Ticket not found or not valid for this event" });
  const checkedInAt = ticketItem?.checkedInAt || (purchase.quantity === 1 ? purchase.checkedInAt : null);
  res.json({ status: checkedInAt ? "already" : "ok", ticketCode: ticketItem?.ticketCode || purchase.ticketCode, attendeeName: purchase.buyerName, attendeeEmail: purchase.buyerEmail, ticketType: purchase.ticket.ticketType, access: purchase.ticket.access, alreadyCheckedIn: Boolean(checkedInAt), checkedInAt: checkedInAt ? checkedInAt.toISOString() : null });
}));

router.post("/camera-sessions", asyncHandler(async (req, res) => {
  const operator = await getAuthenticatedUser(req);
  if (!operator) return res.status(401).json({ message: "Unauthorized" });
  const token = createCameraToken();
  await prisma.creatorEventCheckInCameraSession.updateMany({ where: { eventId: operator.event.id, operatorUserId: operator.id, status: { in: ["ACTIVE", "OPENED", "CONNECTED"] } }, data: { status: "REVOKED", revokedAt: new Date() } });
  const session = await prisma.creatorEventCheckInCameraSession.create({ data: { id: dropid("cameraSession"), eventId: operator.event.id, operatorUserId: operator.id, tokenHash: token.tokenHash, tokenPrefix: token.tokenPrefix, status: "ACTIVE", expiresAt: new Date(Date.now() + CAMERA_TTL_MINUTES * 60 * 1000), clientLabel: req.headers["user-agent"] || null }, include: { event: true, operatorUser: true } });
  res.status(201).json({ token: token.token, tokenPrefix: token.tokenPrefix, cameraUrl: cameraUrl(token.token), qrDataUrl: await cameraQrDataUrl(token.token), expiresAt: session.expiresAt.toISOString(), session: serializeCameraSession(session) });
}));

router.get("/camera-sessions/:token", asyncHandler(async (req, res) => {
  const session = await loadCameraSession(req.params.token);
  if (!session) return res.status(404).json({ message: "Camera session not found" });
  res.json({ session: serializeCameraSession(session), signals: serializeSignals(session.signals, req.query.after) });
}));

router.post("/camera-sessions/:token", asyncHandler(async (req, res) => {
  const token = req.params.token;
  const body = req.body || {};
  const action = String(body.action || "").toLowerCase();
  const session = await loadCameraSession(token);
  if (!session) return res.status(404).json({ message: "Camera session not found" });

  if (action === "signal") {
    if (!body.type) return res.status(400).json({ message: "Signal type is required" });
    const signal = await prisma.creatorEventCheckInCameraSignal.create({ data: { id: dropid("cameraSignal"), sessionId: session.id, sender: body.sender || "phone", type: body.type, payload: JSON.stringify(body.payload || {}) } });
    await prisma.creatorEventCheckInCameraSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
    return res.status(201).json({ signal: { ...signal, createdAt: signal.createdAt.toISOString() } });
  }

  if (action === "open" || action === "connect") {
    const data = action === "open" ? { status: "OPENED", openedAt: session.openedAt || new Date() } : { status: "CONNECTED", connectedAt: session.connectedAt || new Date() };
    const updated = await prisma.creatorEventCheckInCameraSession.update({ where: { id: session.id }, data: { ...data, lastSeenAt: new Date(), clientLabel: body.clientLabel || req.headers["user-agent"] || session.clientLabel }, include: { event: true, operatorUser: true } });
    return res.json({ session: serializeCameraSession(updated), state: action === "open" ? "OPENED" : "CONNECTED" });
  }

  if (action === "complete" || action === "revoke") {
    const operator = await getAuthenticatedUser(req);
    if (!operator || operator.id !== session.operatorUserId) return res.status(401).json({ message: "Unauthorized" });
    const data = action === "complete" ? { status: "COMPLETED", completedAt: new Date(), lastSeenAt: new Date() } : { status: "REVOKED", revokedAt: new Date(), lastSeenAt: new Date() };
    const updated = await prisma.creatorEventCheckInCameraSession.update({ where: { id: session.id }, data, include: { event: true, operatorUser: true } });
    return res.json(serializeCameraSession(updated));
  }

  res.status(400).json({ message: "Unsupported action" });
}));

router.get("/stats", asyncHandler(async (req, res) => {
  const user = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });
  const [total, success, duplicate, invalid] = await Promise.all([
    prisma.creatorEventCheckInScan.count({ where: { eventId: user.event.id } }),
    prisma.creatorEventCheckInScan.count({ where: { eventId: user.event.id, status: "SUCCESS" } }),
    prisma.creatorEventCheckInScan.count({ where: { eventId: user.event.id, status: "DUPLICATE" } }),
    prisma.creatorEventCheckInScan.count({ where: { eventId: user.event.id, status: "INVALID" } }),
  ]);
  res.json({ total, success, duplicate, invalid });
}));

module.exports = router;
