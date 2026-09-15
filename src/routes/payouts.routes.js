const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { asyncHandler, requireAuth, requireCreator } = require("../middleware/auth");
const { HttpError } = require("../middleware/errorHandler");
const { dropid } = require("dropid");
const dropaphi = require("../lib/dropaphi");

const router = express.Router();

const otpSchema = z.object({ otp: z.string().trim().min(1) });

function requireVerifiedEmail(req) {
  if (!req.user.emailVerified) {
    throw new HttpError(403, "Verify your sign-in email before managing payouts");
  }
}

function maskEmail(email) {
  const [name, domain] = email.split("@");
  return `${name.slice(0, 2)}***@${domain}`;
}

function publicAccount(account) {
  return { ...account, accountNumber: `****${account.accountNumber.slice(-4)}` };
}

const accountSchema = z.object({
  bankName: z.string().min(1),
  accountNumber: z.string().min(1),
  accountName: z.string().min(1),
  accountType: z.string().min(1),
  isPrimary: z.boolean().optional(),
});

// GET /api/payouts/accounts
router.get(
  "/accounts",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const accounts = await prisma.creatorPayoutAccount.findMany({
      where: { creatorId: req.creator.id, verified: true },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
    });
    res.json({ accounts: accounts.map(publicAccount) });
  })
);

// POST /api/payouts/accounts/otp
router.post(
  "/accounts/otp",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    requireVerifiedEmail(req);
    await dropaphi.sendOtp(req.user.email, { length: 6, expiry: 10, brandName: "Xonnect" });
    res.json({ ok: true, email: maskEmail(req.user.email), expiresInMinutes: 10 });
  })
);

// POST /api/payouts/accounts — account details are only persisted after OTP verification.
router.post(
  "/accounts",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    requireVerifiedEmail(req);
    const data = accountSchema.parse(req.body);
    const { otp } = otpSchema.parse(req.body);

    const valid = await dropaphi.verifyOtp(req.user.email, otp);
    if (!valid) throw new HttpError(400, "Invalid or expired verification code");

    const account = await prisma.$transaction(async (tx) => {
      if (data.isPrimary) {
        await tx.creatorPayoutAccount.updateMany({
          where: { creatorId: req.creator.id },
          data: { isPrimary: false },
        });
      }

      return tx.creatorPayoutAccount.create({
        data: { id: dropid("bnk"), creatorId: req.creator.id, ...data, verified: true, verifiedAt: new Date() },
      });
    });
    res.status(201).json({ account: publicAccount(account) });
  })
);

const payoutRequestSchema = z.object({
  amount: z.number().int().positive(),
  payoutAccountId: z.string().min(1),
  note: z.string().optional(),
});

async function getEarnings(creatorId, db = prisma) {
  const [videoRevenue, ticketRevenue, payoutTotals] = await Promise.all([
    db.creatorVideoPurchase.aggregate({
      where: { creatorId, status: "COMPLETED" },
      _sum: { revenue: true },
    }),
    db.creatorEventTicketPurchase.aggregate({
      where: { ticket: { event: { creatorId } }, status: "COMPLETED" },
      _sum: { revenue: true },
    }),
    db.creatorPayoutRequest.groupBy({
      by: ["status"],
      where: { creatorId },
      _sum: { amount: true },
    }),
  ]);

  const total = (videoRevenue._sum.revenue || 0) + (ticketRevenue._sum.revenue || 0);
  const paidOut = payoutTotals
    .filter(({ status }) => status === "completed")
    .reduce((sum, { _sum }) => sum + (_sum.amount || 0), 0);
  const pendingPayout = payoutTotals
    .filter(({ status }) => ["pending", "processing"].includes(status))
    .reduce((sum, { _sum }) => sum + (_sum.amount || 0), 0);

  return {
    total,
    paidOut,
    pendingPayout,
    available: Math.max(0, total - paidOut - pendingPayout),
    currency: "NGN",
  };
}

// GET /api/payouts/earnings
router.get(
  "/earnings",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    res.json({ earnings: await getEarnings(req.creator.id) });
  })
);

// GET /api/payouts/requests
router.get(
  "/requests",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const requests = await prisma.creatorPayoutRequest.findMany({
      where: { creatorId: req.creator.id },
      orderBy: { requestedAt: "desc" },
      include: { payoutAccount: true },
    });
    res.json({
      requests: requests.map((request) => ({
        ...request,
        payoutAccount: request.payoutAccount ? publicAccount(request.payoutAccount) : null,
      })),
    });
  })
);

// POST /api/payouts/requests/otp
router.post(
  "/requests/otp",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    requireVerifiedEmail(req);
    await dropaphi.sendOtp(req.user.email, { length: 6, expiry: 10, brandName: "Xonnect" });
    res.json({ ok: true, email: maskEmail(req.user.email), expiresInMinutes: 10 });
  })
);

// POST /api/payouts/requests — creates the payout only after OTP verification.
router.post(
  "/requests",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    requireVerifiedEmail(req);
    const data = payoutRequestSchema.parse(req.body);
    const { otp } = otpSchema.parse(req.body);

    const valid = await dropaphi.verifyOtp(req.user.email, otp);
    if (!valid) throw new HttpError(400, "Invalid or expired verification code");

    const request = await prisma.$transaction(async (tx) => {
      const account = await tx.creatorPayoutAccount.findFirst({
        where: { id: data.payoutAccountId, creatorId: req.creator.id, verified: true },
      });
      if (!account) throw new HttpError(404, "Verified payout account not found");

      const earnings = await getEarnings(req.creator.id, tx);
      if (data.amount > earnings.available) {
        throw new HttpError(400, `Payout amount exceeds available balance of ${earnings.available} ${earnings.currency}`);
      }

      return tx.creatorPayoutRequest.create({
        data: { id: dropid("pyr"), creatorId: req.creator.id, ...data },
        include: { payoutAccount: true },
      });
    });
    res.status(201).json({ request: { ...request, payoutAccount: publicAccount(request.payoutAccount) } });
  })
);

module.exports = router;
