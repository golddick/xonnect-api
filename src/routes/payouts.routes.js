const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { asyncHandler, requireAuth, requireCreator } = require("../middleware/auth");
const { HttpError } = require("../middleware/errorHandler");
const { dropid } = require("dropid");

const router = express.Router();

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
    const accounts = await prisma.creatorPayoutAccount.findMany({ where: { creatorId: req.creator.id } });
    res.json({ accounts });
  })
);

// POST /api/payouts/accounts
router.post(
  "/accounts",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const data = accountSchema.parse(req.body);

    if (data.isPrimary) {
      await prisma.creatorPayoutAccount.updateMany({
        where: { creatorId: req.creator.id },
        data: { isPrimary: false },
      });
    }

    const account = await prisma.creatorPayoutAccount.create({
      data: { id: dropid("bnk"), creatorId: req.creator.id, ...data },
    });
    res.status(201).json({ account });
  })
);

const payoutRequestSchema = z.object({
  amount: z.number().int().positive(),
  payoutAccountId: z.string().optional(),
  note: z.string().optional(),
});

// GET /api/payouts/requests
router.get(
  "/requests",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const requests = await prisma.creatorPayoutRequest.findMany({
      where: { creatorId: req.creator.id },
      orderBy: { createdAt: "desc" },
    });
    res.json({ requests });
  })
);

// POST /api/payouts/requests
router.post(
  "/requests",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const data = payoutRequestSchema.parse(req.body);

    if (data.payoutAccountId) {
      const account = await prisma.creatorPayoutAccount.findUnique({ where: { id: data.payoutAccountId } });
      if (!account || account.creatorId !== req.creator.id) {
        throw new HttpError(404, "Payout account not found");
      }
    }

    const request = await prisma.creatorPayoutRequest.create({
      data: { id: dropid("pyr"), creatorId: req.creator.id, ...data },
    });
    res.status(201).json({ request });
  })
);

module.exports = router;
