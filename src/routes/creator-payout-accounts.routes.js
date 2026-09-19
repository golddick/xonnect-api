const express = require("express");
const { z } = require("zod");
const { dropid } = require("dropid");
const prisma = require("../lib/prisma");
const dropaphi = require("../lib/dropaphi");
const { asyncHandler, requireAuth, requireCreator } = require("../middleware/auth");
const { HttpError } = require("../middleware/errorHandler");

const router = express.Router();

const BANK_CODE_MAP = {
  "Access Bank": "044",
  UBA: "033",
  "Zenith Bank": "057",
  "First Bank": "011",
  OPay: "050",
  GTBank: "058",
};

const accountSchema = z.object({
  bankName: z.string().trim().min(1),
  accountNumber: z.string().trim().min(1),
  accountName: z.string().trim().min(1),
  accountType: z.string().trim().min(1),
  isPrimary: z.boolean().optional().default(false),
});

function publicAccount(account) {
  return account;
}

async function resolveBankCode(bankName, explicitCode) {
  if (explicitCode?.trim()) return explicitCode.trim();

  try {
    const response = await fetch("https://api.paystack.co/bank", {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });
    if (response.ok) {
      const payload = await response.json().catch(() => null);
      const banks = Array.isArray(payload?.data) ? payload.data : [];
      const lowerName = bankName.toLowerCase();
      const match = banks.find((bank) => {
        const name = String(bank.name || "").toLowerCase();
        const code = String(bank.code || "").toLowerCase();
        return name === lowerName || name.includes(lowerName) || code === lowerName;
      });
      if (match?.code) return String(match.code);
    }
  } catch (error) {
    console.warn("Failed to fetch Paystack bank list:", error.message);
  }

  return BANK_CODE_MAP[bankName];
}

async function requireOwnedAccount(req, id) {
  const account = await prisma.creatorPayoutAccount.findFirst({
    where: { id, creatorId: req.creator.id },
  });
  if (!account) throw new HttpError(404, "Payout account not found");
  return account;
}

router.get(
  "/",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const payoutAccounts = await prisma.creatorPayoutAccount.findMany({
      where: { creatorId: req.creator.id },
      orderBy: { createdAt: "asc" },
    });
    res.json({ payoutAccounts: payoutAccounts.map(publicAccount) });
  })
);

router.post(
  "/",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const data = accountSchema.parse(req.body);
    const payoutAccount = await prisma.$transaction(async (tx) => {
      if (data.isPrimary) {
        await tx.creatorPayoutAccount.updateMany({
          where: { creatorId: req.creator.id, isPrimary: true },
          data: { isPrimary: false },
        });
      }
      return tx.creatorPayoutAccount.create({
        data: {
          id: dropid("payout_account"),
          creatorId: req.creator.id,
          ...data,
          verified: false,
        },
      });
    });
    res.status(201).json({ payoutAccount });
  })
);

router.post(
  "/resolve",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const bankName = typeof req.body.bankName === "string" ? req.body.bankName.trim() : "";
    const accountNumber = typeof req.body.accountNumber === "string" ? req.body.accountNumber.trim() : "";
    if (!bankName || !accountNumber) throw new HttpError(400, "Bank name and account number are required");
    if (!/^\d{10}$/.test(accountNumber)) throw new HttpError(400, "Account number must be 10 digits");

    const bankCode = await resolveBankCode(bankName, req.body.bankCode);
    if (!bankCode) throw new HttpError(400, "Unsupported bank selected or unable to determine bank code. Provide a bankCode if possible.");

    const response = await fetch(
      `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.status || !payload.data?.account_name) {
      throw new HttpError(400, payload?.message || "Failed to resolve Paystack bank account");
    }
    res.json({ accountName: payload.data.account_name });
  })
);

router.post(
  "/send-otp",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const result = await dropaphi.sendOtp(req.user.email, {
      brandName: process.env.DROPAPHI_FROM_NAME || "Xonnect",
      expiry: 10,
      length: 6,
    });
    if (result?.ok === false) throw new HttpError(500, result.message || "Failed to send OTP");
    res.json({ message: "OTP sent" });
  })
);

router.post(
  "/verify",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const accountId = typeof req.body.accountId === "string" ? req.body.accountId : "";
    const code = typeof req.body.code === "string" ? req.body.code.trim() : "";
    if (!accountId) throw new HttpError(400, "accountId is required");
    if (!code) throw new HttpError(400, "OTP code is required");

    const account = await requireOwnedAccount(req, accountId);
    const valid = await dropaphi.verifyOtp(req.user.email, code);
    if (!valid) throw new HttpError(401, "Invalid OTP");

    await prisma.creatorPayoutAccount.update({
      where: { id: account.id },
      data: { verified: true, verifiedAt: new Date() },
    });
    res.json({ message: "Payout account verified" });
  })
);

router.put(
  "/:id",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const account = await requireOwnedAccount(req, req.params.id);
    await prisma.creatorPayoutAccount.updateMany({
      where: { creatorId: req.creator.id, isPrimary: true },
      data: { isPrimary: false },
    });
    const payoutAccount = await prisma.creatorPayoutAccount.update({
      where: { id: account.id },
      data: { isPrimary: true },
    });
    res.json({ payoutAccount });
  })
);

router.delete(
  "/:id",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const account = await requireOwnedAccount(req, req.params.id);
    await prisma.creatorPayoutAccount.delete({ where: { id: account.id } });

    if (account.isPrimary) {
      const nextAccount = await prisma.creatorPayoutAccount.findFirst({
        where: { creatorId: req.creator.id },
        orderBy: { createdAt: "asc" },
      });
      if (nextAccount) {
        await prisma.creatorPayoutAccount.update({
          where: { id: nextAccount.id },
          data: { isPrimary: true },
        });
      }
    }
    res.json({ message: "Payout account removed" });
  })
);

module.exports = router;
