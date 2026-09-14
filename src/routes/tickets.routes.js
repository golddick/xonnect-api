// This router is mounted at /api (not /api/tickets) because it owns two path
// families: /events/:eventId/tickets (ticket-type management) and
// /tickets/... (purchasing / lookup). See server.js.
const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { asyncHandler, requireAuth, requireCreator } = require("../middleware/auth");
const { HttpError } = require("../middleware/errorHandler");
const paystack = require("../lib/paystack");
const { dropid } = require("dropid");

const router = express.Router();

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
