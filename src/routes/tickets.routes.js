// This router is mounted at /api (not /api/tickets) because it owns two path
// families: /events/:eventId/tickets (ticket-type management) and
// /tickets/... (purchasing / lookup). See server.js.
const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { asyncHandler, requireAuth, optionalAuth, requireCreator } = require("../middleware/auth");
const { HttpError } = require("../middleware/errorHandler");
const paystack = require("../lib/paystack");
const { dropid } = require("dropid");

const router = express.Router();

function serializePublicTicketEvent(event) {
  const tickets = (event.tickets || [])
    .map((ticket) => {
      const remaining = Math.max((ticket.quantity || 0) - (ticket.soldCount || 0), 0);
      const access = String(ticket.access || "STREAM").toUpperCase() === "VENUE" ? "VENUE" : "STREAM";

      return {
        id: ticket.id,
        ticketType: ticket.ticketType,
        access,
        price: ticket.price || 0,
        quantity: ticket.quantity || 0,
        soldCount: ticket.soldCount || 0,
        revenue: ticket.revenue || 0,
        description: ticket.description || null,
        benefits: Array.isArray(ticket.benefits) ? ticket.benefits.map(String) : [],
        status: ticket.status || "ACTIVE",
        remaining,
        isSoldOut: remaining <= 0 || String(ticket.status || "").toUpperCase() === "SOLD_OUT",
      };
    })
    .sort((left, right) => (left.access === "VENUE" ? -1 : 1) - (right.access === "VENUE" ? -1 : 1) || left.price - right.price);

  const prices = tickets.map((ticket) => ticket.price).filter(Number.isFinite);
  const hasVenue = tickets.some((ticket) => ticket.access === "VENUE");
  const hasStream = tickets.some((ticket) => ticket.access === "STREAM");

  return {
    id: event.id,
    title: event.title,
    description: event.description || null,
    category: event.category || "general",
    status: event.status || "SCHEDULED",
    scheduledAt: event.scheduledAt ? new Date(event.scheduledAt).toISOString() : null,
    timezone: event.timezone || "Africa/Lagos",
    address: event.address || null,
    locationName: event.locationName || null,
    locationFullAddress: event.locationFullAddress || null,
    locationCountry: event.locationCountry || null,
    locationState: event.locationState || null,
    locationType: event.locationType || null,
    thumbnailUrl: event.thumbnailUrl || null,
    thumbnailVideoUrl: event.thumbnailVideoUrl || null,
    creator: {
      id: event.creator?.id || "",
      fullName: event.creator?.profile?.fullName || event.creator?.profile?.creatorName || "Creator",
      avatarUrl: event.creator?.profile?.avatarUrl || null,
    },
    tickets,
    ticketCount: tickets.length,
    totalSold: tickets.reduce((sum, ticket) => sum + ticket.soldCount, 0),
    totalCapacity: tickets.reduce((sum, ticket) => sum + ticket.quantity, 0),
    minPrice: prices.length ? Math.min(...prices) : 0,
    maxPrice: prices.length ? Math.max(...prices) : 0,
    totalRevenue: tickets.reduce((sum, ticket) => sum + ticket.revenue, 0),
    isHybrid: hasVenue && hasStream,
    eventType: hasVenue && hasStream ? "hybrid" : hasVenue ? "venue" : "streaming",
  };
}

const publicEventInclude = {
  creator: { include: { profile: { select: { fullName: true, creatorName: true, avatarUrl: true } } } },
  tickets: {
    where: { status: { in: ["ACTIVE", "SOLD_OUT"] } },
    orderBy: [{ price: "asc" }, { createdAt: "asc" }],
  },
};

async function findPublicEvent(eventId) {
  return prisma.creatorEvent.findFirst({
    where: {
      id: eventId,
      isPrivate: false,
      status: { in: ["SCHEDULED", "LIVE", "ENDED"] },
    },
    include: publicEventInclude,
  });
}

// GET /api/tickets - public ticketed events for the landing page
router.get(
  "/tickets",
  asyncHandler(async (req, res) => {
    const events = await prisma.creatorEvent.findMany({
      where: {
        isPrivate: false,
        status: { in: ["SCHEDULED", "LIVE", "ENDED"] },
        tickets: { some: { status: { in: ["ACTIVE", "SOLD_OUT"] } } },
      },
      orderBy: [{ scheduledAt: "asc" }, { createdAt: "desc" }],
      include: publicEventInclude,
    });

    const grouped = events.map(serializePublicTicketEvent);
    res.json({ events: grouped, total: grouped.length });
  })
);

// GET /api/tickets/:eventId - public ticket event details for the landing page
router.get(
  "/tickets/:eventId(event_[^/]+)",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const event = await findPublicEvent(req.params.eventId);
    if (!event) throw new HttpError(404, "Event not found");

    res.json({ event: serializePublicTicketEvent(event) });
  })
);

const publicCheckoutSchema = z.object({
  ticketId: z.string().min(1),
  buyerName: z.string().optional(),
  buyerEmail: z.string().email().optional(),
  buyerPhone: z.string().optional().nullable(),
  quantity: z.number().int().min(1).default(1),
});

// POST /api/tickets/:eventId - public checkout for a ticket belonging to this event
router.post(
  "/tickets/:eventId(event_[^/]+)",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { ticketId, buyerName, buyerEmail, buyerPhone, quantity } = publicCheckoutSchema.parse(req.body);
    const event = await findPublicEvent(req.params.eventId);
    if (!event) throw new HttpError(404, "Event not found");

    const ticket = event.tickets.find((entry) => entry.id === ticketId);
    if (!ticket) throw new HttpError(404, "Ticket type not found for this event");

    const remaining = Math.max((ticket.quantity || 0) - (ticket.soldCount || 0), 0);
    if (remaining <= 0) throw new HttpError(409, "Ticket is sold out");
    if (quantity > remaining) throw new HttpError(400, "Requested quantity exceeds available tickets");

    const isStreamTicket = String(ticket.access || "STREAM").toUpperCase() !== "VENUE";
    const sessionEmail = req.user?.email?.trim().toLowerCase() || "";
    const email = isStreamTicket ? sessionEmail : (buyerEmail || sessionEmail).trim().toLowerCase();

    if (isStreamTicket && !sessionEmail) {
      throw new HttpError(401, "You must be signed in to purchase streaming access.");
    }
    if (!email) throw new HttpError(400, "Email is required");

    const name = (isStreamTicket ? req.user?.fullName : buyerName || req.user?.fullName)?.trim() || email.split("@")[0];
    const amount = Math.max(Math.round(ticket.price || 0), 0) * quantity;
    const reference = dropid("txn");

    const purchase = await prisma.creatorEventTicketPurchase.create({
      data: {
        id: dropid("pur"),
        ticketId: ticket.id,
        buyerName: name,
        buyerEmail: email,
        buyerPhone: buyerPhone?.trim() || null,
        quantity,
        amount,
        transactionId: reference,
        ticketCode: `PENDING-${reference}`,
        status: "PENDING",
      },
    });

    if (amount === 0) {
      const completed = await completeTicketPurchase(purchase.id);
      return res.json({
        message: "Ticket reserved",
        payment: { type: "free", reference },
        purchase: completed,
      });
    }

    const payment = await paystack.initializeTransaction({
      email,
      amountKobo: amount * 100,
      reference,
      callbackUrl: `${process.env.APP_BASE_URL}/tickets/${encodeURIComponent(event.id)}?reference=${encodeURIComponent(reference)}&ticketId=${encodeURIComponent(ticket.id)}`,
      metadata: {
        type: "ticket",
        eventId: event.id,
        ticketId: ticket.id,
        purchaseId: purchase.id,
        quantity,
        buyerName: name,
        buyerEmail: email,
      },
    });

    res.json({
      message: "Payment initialized",
      payment,
      purchase: { id: purchase.id, reference, amount, quantity },
      event: serializePublicTicketEvent(event),
    });
  })
);

const createTicketSchema = z.object({
  ticketType: z.string().min(1),
  access: z.enum(["STREAM", "VENUE"]).default("STREAM"),
  price: z.number().int().min(0),
  quantity: z.number().int().min(0),
  description: z.string().optional(),
  benefits: z.array(z.string()).optional(),
});

// POST /api/events/:eventId/tickets — creator only, defines a ticket tier for their event
router.post(
  "/events/:eventId/tickets",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const event = await prisma.creatorEvent.findUnique({ where: { id: req.params.eventId } });
    if (!event) throw new HttpError(404, "Event not found");
    if (event.creatorId !== req.creator.id) throw new HttpError(403, "You don't own this event");

    const data = createTicketSchema.parse(req.body);
    const ticket = await prisma.creatorEventTicket.create({
      data: { id: dropid("tkt"), eventId: event.id, ...data },
    });

    res.status(201).json({ ticket });
  })
);

// GET /api/events/:eventId/tickets — public list of available ticket tiers
router.get(
  "/events/:eventId/tickets",
  asyncHandler(async (req, res) => {
    const tickets = await prisma.creatorEventTicket.findMany({
      where: { eventId: req.params.eventId },
      orderBy: { price: "asc" },
    });
    res.json({ tickets });
  })
);

const updateTicketSchema = createTicketSchema.partial().extend({
  status: z.enum(["ACTIVE", "PAUSED", "SOLD_OUT", "ARCHIVED"]).optional(),
});

// PUT /api/tickets/:ticketId — creator only
router.put(
  "/tickets/:ticketId",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const ticket = await prisma.creatorEventTicket.findUnique({
      where: { id: req.params.ticketId },
      include: { event: true },
    });
    if (!ticket) throw new HttpError(404, "Ticket not found");
    if (ticket.event.creatorId !== req.creator.id) throw new HttpError(403, "You don't own this ticket");

    const data = updateTicketSchema.parse(req.body);
    const updated = await prisma.creatorEventTicket.update({ where: { id: ticket.id }, data });
    res.json({ ticket: updated });
  })
);

const purchaseInitSchema = z.object({
  buyerName: z.string().min(1),
  buyerEmail: z.string().email(),
  buyerPhone: z.string().optional(),
  quantity: z.number().int().min(1).default(1),
});

// POST /api/tickets/:ticketId/purchase/initialize
// Creates a PENDING purchase and starts a Paystack transaction. The purchase is only marked
// COMPLETED once Paystack confirms payment via the /api/payments/paystack/webhook handler —
// never trust a client-reported "payment succeeded" on its own.
router.post(
  "/tickets/:ticketId/purchase/initialize",
  asyncHandler(async (req, res) => {
    const { buyerName, buyerEmail, buyerPhone, quantity } = purchaseInitSchema.parse(req.body);

    const ticket = await prisma.creatorEventTicket.findUnique({ where: { id: req.params.ticketId } });
    if (!ticket) throw new HttpError(404, "Ticket not found");
    if (ticket.status !== "ACTIVE") throw new HttpError(400, "This ticket is not currently available");
    if (ticket.quantity > 0 && ticket.soldCount + quantity > ticket.quantity) {
      throw new HttpError(400, "Not enough tickets remaining");
    }

    const amount = ticket.price * quantity;
    const reference = dropid("txn");

    const purchase = await prisma.creatorEventTicketPurchase.create({
      data: {
        id: dropid("pur"),
        ticketId: ticket.id,
        buyerName,
        buyerEmail,
        buyerPhone,
        quantity,
        amount,
        transactionId: reference,
        ticketCode: `PENDING-${reference}`, // replaced with a real code once payment completes
        status: "PENDING",
      },
    });

    if (amount === 0) {
      // Free ticket — skip Paystack entirely and complete immediately.
      const completed = await completeTicketPurchase(purchase.id);
      return res.status(201).json({ purchase: completed, free: true });
    }

    const paystackTx = await paystack.initializeTransaction({
      email: buyerEmail,
      amountKobo: amount * 100,
      reference,
      callbackUrl: `${process.env.APP_BASE_URL}/payments/callback`,
      metadata: { type: "ticket", purchaseId: purchase.id, ticketId: ticket.id },
    });

    res.status(201).json({ purchase, authorizationUrl: paystackTx.authorization_url, reference });
  })
);

// GET /api/tickets/purchases/:ticketCode — look up a completed ticket by its code
router.get(
  "/tickets/purchases/:ticketCode",
  asyncHandler(async (req, res) => {
    const purchase = await prisma.creatorEventTicketPurchase.findUnique({
      where: { ticketCode: req.params.ticketCode },
      include: { ticket: { include: { event: true } } },
    });
    if (!purchase) throw new HttpError(404, "Ticket not found");
    res.json({ purchase });
  })
);

// GET /api/tickets/my — the logged-in user's own tickets (matched by email)
router.get(
  "/tickets/my",
  requireAuth,
  asyncHandler(async (req, res) => {
    const purchases = await prisma.creatorEventTicketPurchase.findMany({
      where: { buyerEmail: req.user.email, status: "COMPLETED" },
      orderBy: { purchasedAt: "desc" },
      include: { ticket: { include: { event: true } } },
    });
    res.json({ purchases });
  })
);

/**
 * Marks a PENDING ticket purchase COMPLETED, using the *current* creator payout
 * percentage for the ticket's access type (STREAM vs VENUE) to split revenue —
 * this is what "payout structure is under creator" means in practice: we read
 * creator.eventStreamPayout / eventVenuePayout at completion time rather than
 * hardcoding a platform fee.
 * Exported so the Paystack webhook handler (payments.routes.js) can call it too.
 */
async function completeTicketPurchase(purchaseId) {
  return prisma.$transaction(async (tx) => {
    const purchase = await tx.creatorEventTicketPurchase.findUnique({
      where: { id: purchaseId },
      include: { ticket: { include: { event: { include: { creator: true } } } } },
    });
    if (!purchase) throw new HttpError(404, "Purchase not found");
    if (purchase.status === "COMPLETED") return purchase; // idempotent

    const { ticket } = purchase;
    const creator = ticket.event.creator;
    const payoutPct = ticket.access === "VENUE" ? creator.eventVenuePayout : creator.eventStreamPayout;

    const revenue = Math.round((purchase.amount * payoutPct) / 100);
    const platformFee = purchase.amount - revenue;

    const updated = await tx.creatorEventTicketPurchase.update({
      where: { id: purchase.id },
      data: {
        status: "COMPLETED",
        revenue,
        platformFee,
        ticketCode: `XON-${dropid("").slice(0, 8).toUpperCase()}`,
      },
    });

    await tx.creatorEventTicket.update({
      where: { id: ticket.id },
      data: {
        soldCount: { increment: purchase.quantity },
        revenue: { increment: revenue },
        amount: { increment: purchase.amount },
        platformFee: { increment: platformFee },
        ...(ticket.quantity > 0 && ticket.soldCount + purchase.quantity >= ticket.quantity
          ? { status: "SOLD_OUT" }
          : {}),
      },
    });

    await tx.creatorEvent.update({
      where: { id: ticket.eventId },
      data: {
        revenue: { increment: revenue },
        amount: { increment: purchase.amount },
        platformFee: { increment: platformFee },
      },
    });

    return updated;
  });
}

module.exports = router;
module.exports.completeTicketPurchase = completeTicketPurchase;
