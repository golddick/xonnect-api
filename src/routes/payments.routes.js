const express = require("express");
const prisma = require("../lib/prisma");
const { asyncHandler } = require("../middleware/auth");
const { HttpError } = require("../middleware/errorHandler");
const paystack = require("../lib/paystack");
const dropaphi = require("../lib/dropaphi");
const ticketsRoutes = require("./tickets.routes");
const videosRoutes = require("./videos.routes");
const { ticketReceiptTemplate, creatorPlatformNotificationTemplate } = require("../utils/email-templates");

const router = express.Router();

/**
 * POST /api/payments/paystack/webhook
 * Mounted with express.raw() in server.js (BEFORE the global express.json() middleware)
 * so `req.body` here is the raw Buffer needed for signature verification.
 */
router.post(
  "/paystack/webhook",
  asyncHandler(async (req, res) => {
    const signature = req.headers["x-paystack-signature"];
    const rawBody = req.body; // Buffer, thanks to express.raw()

    if (!signature || !paystack.verifyWebhookSignature(rawBody, signature)) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = JSON.parse(rawBody.toString("utf8"));

    // Always acknowledge quickly; do the real work after responding is not strictly needed
    // here since our completion logic is fast, but we still respond 200 on any known event
    // to stop Paystack from retrying, even if we choose to ignore the event type.
    if (event.event !== "charge.success") {
      return res.status(200).json({ received: true });
    }

    const reference = event.data.reference;

    // Re-verify directly with Paystack rather than trusting the webhook payload alone.
    const verified = await paystack.verifyTransaction(reference);
    if (verified.status !== "success") {
      return res.status(200).json({ received: true, ignored: "not successful on verify" });
    }

    const metadata = {
      ...(event.data.metadata || {}),
      ...(verified.metadata || {}),
    };

    try {
      const purchaseKind = metadata.purchaseKind || metadata.type;
      if (purchaseKind === "video" || metadata.videoPurchaseId || metadata.creatorVideoId) {
        const purchaseId = metadata.videoPurchaseId || metadata.purchaseId;
        const purchase = await videosRoutes.completeVideoPurchase(purchaseId);
        await sendVideoReceipt(purchase).catch((error) => console.error("Video receipt failed:", error));
      } else if (purchaseKind === "ticket" || metadata.purchaseId || metadata.ticketId) {
        const purchase = await ticketsRoutes.completeTicketPurchase(metadata.purchaseId);
        await sendTicketReceipt(purchase).catch((error) => console.error("Ticket receipt failed:", error));
      } else {
        console.warn("Paystack webhook: unknown metadata.type", metadata);
      }
    } catch (err) {
      console.error("Failed to complete purchase from webhook:", err);
      // Still 200 so Paystack doesn't hammer retries; investigate via logs/reference.
    }

    res.status(200).json({ received: true });
  })
);

/**
 * GET /api/payments/status/:reference
 * The mobile app polls this after returning from the Paystack checkout screen
 * (deep-link/callback timing can't be fully relied on, so polling is the safe pattern).
 */
router.get(
  "/status/:reference",
  asyncHandler(async (req, res) => {
    const { reference } = req.params;

    const ticketPurchase = await prisma.creatorEventTicketPurchase.findUnique({
      where: { transactionId: reference },
    });
    if (ticketPurchase) {
      return res.json({ type: "ticket", status: ticketPurchase.status, purchase: ticketPurchase });
    }

    const videoPurchase = await prisma.creatorVideoPurchase.findUnique({
      where: { transactionId: reference },
    });
    if (videoPurchase) {
      return res.json({ type: "video", status: videoPurchase.status, purchase: videoPurchase });
    }

    throw new HttpError(404, "No purchase found for this reference");
  })
);

async function sendTicketReceipt(purchase) {
  const ticket = await prisma.creatorEventTicket.findUnique({
    where: { id: purchase.ticketId },
    include: { event: true },
  });

  await dropaphi.sendEmail({
    to: purchase.buyerEmail,
    subject: `Your Xonnect ticket for ${ticket?.event?.title || "your event"}`,
    html: ticketReceiptTemplate({
      fullName: purchase.buyerName,
      eventTitle: ticket?.event?.title || "your event",
      ticketType: ticket?.ticketType || "Ticket",
      ticketCode: purchase.ticketCode,
      quantity: purchase.quantity,
      amount: `${purchase.currency || "NGN"} ${purchase.amount.toLocaleString()}`,
      watchUrl: `${process.env.APP_BASE_URL || "http://localhost:3000"}/tv/watch/event/${ticket?.eventId || ""}`,
    }),
    text: `Your ticket code is ${purchase.ticketCode}`,
    fromName: "Xonnect",
  });
}

async function sendVideoReceipt(purchase) {
  const video = await prisma.creatorVideo.findUnique({
    where: { id: purchase.creatorVideoId },
    select: { title: true, folderId: true },
  });
  if (!purchase.buyerEmail || !video) return;

  const watchUrl = `${process.env.APP_BASE_URL || "http://localhost:3000"}/tv/watch/folder/${video.folderId}?part=${video.id}&accessCode=${purchase.accessCode || ""}`;
  await dropaphi.sendEmail({
    to: purchase.buyerEmail,
    subject: `Your access for ${video.title} is ready`,
    html: creatorPlatformNotificationTemplate({
      fullName: purchase.buyerName || purchase.buyerEmail.split("@")[0],
      message: `Thank you for your purchase.\n\nAccess code: ${purchase.accessCode || ""}\n\nWatch here: ${watchUrl}`,
    }),
    text: `Your access code is ${purchase.accessCode || ""}. Watch here: ${watchUrl}`,
    fromName: "Xonnect",
  });
}

module.exports = router;
