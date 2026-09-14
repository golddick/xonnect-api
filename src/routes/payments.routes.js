const express = require("express");
const prisma = require("../lib/prisma");
const { asyncHandler } = require("../middleware/auth");
const { HttpError } = require("../middleware/errorHandler");
const paystack = require("../lib/paystack");
const dropaphi = require("../lib/dropaphi");
const ticketsRoutes = require("./tickets.routes");
const videosRoutes = require("./videos.routes");

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

    const metadata = verified.metadata || event.data.metadata || {};

    try {
      if (metadata.type === "ticket") {
        const purchase = await ticketsRoutes.completeTicketPurchase(metadata.purchaseId);
        await sendTicketReceipt(purchase).catch(() => {});
      } else if (metadata.type === "video") {
        await videosRoutes.completeVideoPurchase(metadata.purchaseId);
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
  await dropaphi.sendEmail({
    to: purchase.buyerEmail,
    subject: "Your Xonnect ticket",
    html: `<p>Hi ${purchase.buyerName},</p><p>Your ticket is confirmed. Your ticket code is <b>${purchase.ticketCode}</b>. Show this at the gate to check in.</p>`,
    text: `Your ticket code is ${purchase.ticketCode}`,
    fromName: "Xonnect",
  });
}

module.exports = router;
