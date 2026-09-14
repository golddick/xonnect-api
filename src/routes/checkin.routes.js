const express = require("express");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { asyncHandler, requireAuth, requireCreator } = require("../middleware/auth");
const { HttpError } = require("../middleware/errorHandler");
const { signAuthToken } = require("../utils/tokens");
const jwt = require("jsonwebtoken");
const dropaphi = require("../lib/dropaphi");
const { dropid } = require("dropid");

const router = express.Router();

const createStaffSchema = z.object({
  eventId: z.string().min(1),
  fullName: z.string().min(1),
  email: z.string().email(),
  username: z.string().min(3),
  gateName: z.string().min(1),
});

// POST /api/checkin/staff — creator creates a gate/check-in staff account for an event
router.post(
  "/staff",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const data = createStaffSchema.parse(req.body);

    const event = await prisma.creatorEvent.findUnique({ where: { id: data.eventId } });
    if (!event) throw new HttpError(404, "Event not found");
    if (event.creatorId !== req.creator.id) throw new HttpError(403, "You don't own this event");

    const tempPassword = Math.random().toString(36).slice(-10);
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    const staff = await prisma.creatorEventCheckInUser.create({
      data: {
        id: dropid("gts"),
        creatorId: req.creator.id,
        eventId: event.id,
        fullName: data.fullName,
        email: data.email,
        username: data.username,
        gateName: data.gateName,
        passwordHash,
        mustChangePassword: true,
      },
    });

    // Email the temp password via DropAphi instead of exposing it in the response.
    let emailSent = true;
    try {
      await dropaphi.sendEmail({
        to: data.email,
        subject: "Your Xonnect gate check-in access",
        html: `<p>Hi ${data.fullName},</p><p>You've been added as gate staff (${data.gateName}) for an Xonnect event.</p><p>Username: <b>${data.username}</b><br/>Temporary password: <b>${tempPassword}</b></p><p>You'll be asked to change this password on first login.</p>`,
        text: `Username: ${data.username}\nTemporary password: ${tempPassword}`,
        fromName: "Xonnect",
      });
    } catch (err) {
      emailSent = false;
      console.error("DropAphi sendEmail failed:", err.message);
    }

    res.status(201).json({ staff: sanitizeStaff(staff), emailSent, ...(emailSent ? {} : { tempPassword }) });
  })
);

const staffLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

// POST /api/checkin/login — gate staff auth (separate token audience from main app auth)
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { username, password } = staffLoginSchema.parse(req.body);

    const staff = await prisma.creatorEventCheckInUser.findUnique({ where: { username } });
    if (!staff || staff.status !== "ACTIVE") throw new HttpError(401, "Invalid username or password");

    const valid = await bcrypt.compare(password, staff.passwordHash);
    if (!valid) throw new HttpError(401, "Invalid username or password");

    await prisma.creatorEventCheckInUser.update({
      where: { id: staff.id },
      data: { lastLoginAt: new Date() },
    });

    const token = jwt.sign({ sub: staff.id, aud: "checkin-staff", eventId: staff.eventId }, process.env.JWT_SECRET, {
      expiresIn: "12h",
    });

    res.json({ token, staff: sanitizeStaff(staff), mustChangePassword: staff.mustChangePassword });
  })
);

// Middleware: require a valid gate-staff token (kept local to this router; separate audience from user auth)
const requireStaffAuth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing Authorization header" });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  if (payload.aud !== "checkin-staff") return res.status(401).json({ error: "Invalid token audience" });

  const staff = await prisma.creatorEventCheckInUser.findUnique({ where: { id: payload.sub } });
  if (!staff || staff.status !== "ACTIVE") return res.status(401).json({ error: "Staff account not found" });

  req.staff = staff;
  next();
});

const scanSchema = z.object({ scannedCode: z.string().min(1) });

// POST /api/checkin/scan — scan a ticket code at the gate
router.post(
  "/scan",
  requireStaffAuth,
  asyncHandler(async (req, res) => {
    const { scannedCode } = scanSchema.parse(req.body);
    const staff = req.staff;

    const result = await prisma.$transaction(async (tx) => {
      const purchase = await tx.creatorEventTicketPurchase.findUnique({
        where: { ticketCode: scannedCode },
        include: { ticket: true },
      });

      let status = "INVALID";
      let purchaseId = null;

      if (!purchase || purchase.ticket.eventId !== staff.eventId) {
        status = "INVALID";
      } else if (purchase.checkedInAt) {
        status = "DUPLICATE";
      } else if (purchase.status !== "COMPLETED") {
        status = "REJECTED";
      } else {
        status = "SUCCESS";
        purchaseId = purchase.id;
        await tx.creatorEventTicketPurchase.update({
          where: { id: purchase.id },
          data: { checkedInAt: new Date(), checkedInByUserId: staff.id },
        });
      }

      const scan = await tx.creatorEventCheckInScan.create({
        data: {
          id: dropid("scn"),
          eventId: staff.eventId,
          checkInUserId: staff.id,
          ticketPurchaseId: purchaseId,
          attendeeName: purchase?.buyerName,
          attendeeEmail: purchase?.buyerEmail,
          gateName: staff.gateName,
          scannedCode,
          status,
        },
      });

      await tx.creatorEventCheckInUser.update({
        where: { id: staff.id },
        data: { scansToday: { increment: 1 }, totalScans: { increment: 1 }, lastScanAt: new Date() },
      });

      return { scan, purchase };
    });

    res.json(result);
  })
);

// GET /api/checkin/stats — today's scan stats for the logged-in staff/event
router.get(
  "/stats",
  requireStaffAuth,
  asyncHandler(async (req, res) => {
    const [total, success, duplicate, invalid] = await Promise.all([
      prisma.creatorEventCheckInScan.count({ where: { eventId: req.staff.eventId } }),
      prisma.creatorEventCheckInScan.count({ where: { eventId: req.staff.eventId, status: "SUCCESS" } }),
      prisma.creatorEventCheckInScan.count({ where: { eventId: req.staff.eventId, status: "DUPLICATE" } }),
      prisma.creatorEventCheckInScan.count({ where: { eventId: req.staff.eventId, status: "INVALID" } }),
    ]);
    res.json({ total, success, duplicate, invalid });
  })
);

function sanitizeStaff(staff) {
  const { passwordHash, tempPasswordHash, ...rest } = staff;
  return rest;
}

module.exports = router;
