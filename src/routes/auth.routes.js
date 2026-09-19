const express = require("express");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { asyncHandler, requireAuth } = require("../middleware/auth");
const { HttpError } = require("../middleware/errorHandler");
const { signAuthToken, id } = require("../utils/tokens");
const dropaphi = require("../lib/dropaphi");
const { dropid } = require("dropid");

const router = express.Router();

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  fullName: z.string().min(1).optional(),
});

// POST /api/auth/signup
router.post(
  "/signup",
  asyncHandler(async (req, res) => {
    const { email, password, fullName } = signupSchema.parse(req.body);
    const normalizedEmail = email.toLowerCase().trim();

    const existing = await prisma.profile.findUnique({ where: { email: normalizedEmail } });
    if (existing) throw new HttpError(409, "An account with this email already exists");

    const passwordHash = await bcrypt.hash(password, 10);
    const profileId = dropid("usr");

    const profile = await prisma.profile.create({
      data: {
        id: profileId,
        email: normalizedEmail,
        fullName,
        hasPassword: true,
        credential: { create: { passwordHash } },
      },
    });

    // DropAphi sends and manages the OTP itself — we never see or store the raw code.
    await dropaphi.sendOtp(normalizedEmail, { length: 6, expiry: 10, brandName: "Xonnect" }).catch((err) => {
      console.error("DropAphi sendOtp failed:", err.message);
    });

    const authToken = signAuthToken({ sub: profile.id, email: profile.email });
    res.status(201).json({ token: authToken, user: toPublicProfile(profile) });
  })
);

const verifyEmailSchema = z.object({
  email: z.string().email(),
  token: z.string().min(1), // the OTP code the user typed in
});

// POST /api/auth/verify-email
router.post(
  "/verify-email",
  asyncHandler(async (req, res) => {
    const { email, token } = verifyEmailSchema.parse(req.body);
    const normalizedEmail = email.toLowerCase().trim();

    const valid = await dropaphi.verifyOtp(normalizedEmail, token);
    if (!valid) throw new HttpError(400, "Invalid or expired verification code");

    await prisma.profile.update({ where: { email: normalizedEmail }, data: { emailVerified: true } });
    res.json({ ok: true });
  })
);

// POST /api/auth/resend-verification
router.post(
  "/resend-verification",
  asyncHandler(async (req, res) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const normalizedEmail = email.toLowerCase().trim();

    const profile = await prisma.profile.findUnique({ where: { email: normalizedEmail } });
    if (!profile) return res.json({ ok: true }); // don't leak account existence

    await dropaphi.sendOtp(normalizedEmail, { length: 6, expiry: 10, brandName: "Xonnect" });
    res.json({ ok: true });
  })
);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).optional(),
});

// POST /api/auth/login
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const normalizedEmail = email.toLowerCase().trim();

    const profile = await prisma.profile.findUnique({
      where: { email: normalizedEmail },
      include: { credential: true, creator: true },
    });

    if (!password) {
      return res.json({
        exists: Boolean(profile),
        hasPassword: Boolean(profile?.credential),
        emailVerified: Boolean(profile?.emailVerified),
        fullName: profile?.fullName ?? null,
      });
    }

    if (!profile || !profile.credential) {
      throw new HttpError(401, "Invalid email or password");
    }

    const valid = await bcrypt.compare(password, profile.credential.passwordHash);
    if (!valid) throw new HttpError(401, "Invalid email or password");

    const updatedProfile = await prisma.profile.update({
      where: { id: profile.id },
      data: { lastLogin: new Date() },
    });

    const token = signAuthToken({ sub: profile.id, email: profile.email });
    res.json({ token, user: toPublicProfile(updatedProfile) });
  })
);

router.post(
  "/superadmin/login",
  asyncHandler(async (req, res) => {
    const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const profile = await prisma.profile.findUnique({ where: { email: email.toLowerCase().trim() }, include: { credential: true } });
    if (!profile || !["ADMIN", "SUPERADMIN"].includes(profile.role)) throw new HttpError(401, "Invalid email or password");
    if (!profile.credential || !await bcrypt.compare(password, profile.credential.passwordHash)) throw new HttpError(401, "Invalid email or password");
    await prisma.profile.update({ where: { id: profile.id }, data: { lastLogin: new Date() } });
    const token = signAuthToken({ sub: profile.id, email: profile.email });
    res.json({ ok: true, role: profile.role, token, loginToken: token });
  })
);

const otpSendSchema = z.object({ email: z.string().email() });

// POST /api/auth/otp/send
router.post(
  "/otp/send",
  asyncHandler(async (req, res) => {
    const { email } = otpSendSchema.parse(req.body);
    const normalizedEmail = email.toLowerCase().trim();
    const profile = await prisma.profile.findUnique({ where: { email: normalizedEmail } });

    if (!profile) throw new HttpError(404, "Account not found");

    const result = await dropaphi.sendOtp(normalizedEmail, {
      length: 6,
      expiry: 10,
      brandName: process.env.DROPAPHI_FROM_NAME || "Xonnect",
    });

    if (result?.ok === false) {
      throw new HttpError(result.cooldown ? 429 : 500, result.message || "Failed to send OTP");
    }

    res.json({ ok: true });
  })
);

const otpVerifySchema = z.object({
  email: z.string().email(),
  code: z.string().trim().min(1),
});

// POST /api/auth/otp/verify
router.post(
  "/otp/verify",
  asyncHandler(async (req, res) => {
    const { email, code } = otpVerifySchema.parse(req.body);
    const normalizedEmail = email.toLowerCase().trim();
    const profile = await prisma.profile.findUnique({
      where: { email: normalizedEmail },
      include: { creator: true },
    });

    if (!profile) throw new HttpError(404, "Account not found");

    const valid = await dropaphi.verifyOtp(normalizedEmail, code);
    if (!valid) throw new HttpError(401, "Invalid OTP");

    const updatedProfile = await prisma.profile.update({
      where: { id: profile.id },
      data: { emailVerified: true, lastLogin: new Date() },
      include: { creator: true },
    });

    const token = signAuthToken({ sub: updatedProfile.id, email: updatedProfile.email });
    res.json({ ok: true, token, loginToken: token, user: toPublicProfile(updatedProfile) });
  })
);

const forgotSchema = z.object({ email: z.string().email() });

// POST /api/auth/forgot-password
router.post(
  "/forgot-password",
  asyncHandler(async (req, res) => {
    const { email } = forgotSchema.parse(req.body);
    const normalizedEmail = email.toLowerCase().trim();

    const profile = await prisma.profile.findUnique({ where: { email: normalizedEmail } });
    if (!profile) return res.json({ ok: true }); // don't leak account existence

    await dropaphi.sendOtp(normalizedEmail, { length: 6, expiry: 10, brandName: "Xonnect (password reset)" });
    res.json({ ok: true });
  })
);

const resetSchema = z.object({
  email: z.string().email(),
  token: z.string().min(1), // the OTP code the user typed in
  newPassword: z.string().min(8),
});

// POST /api/auth/reset-password
router.post(
  "/reset-password",
  asyncHandler(async (req, res) => {
    const { email, token, newPassword } = resetSchema.parse(req.body);
    const normalizedEmail = email.toLowerCase().trim();

    const valid = await dropaphi.verifyOtp(normalizedEmail, token);
    if (!valid) throw new HttpError(400, "Invalid or expired reset code");

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await prisma.$transaction([
      prisma.authCredential.upsert({
        where: { email: normalizedEmail },
        update: { passwordHash },
        create: { email: normalizedEmail, passwordHash },
      }),
      prisma.profile.update({ where: { email: normalizedEmail }, data: { hasPassword: true } }),
    ]);

    res.json({ ok: true });
  })
);

router.post(
  "/password/set",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { password } = z.object({ password: z.string().min(8) }).parse(req.body);
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.$transaction([
      prisma.authCredential.upsert({
        where: { email: req.user.email },
        update: { passwordHash },
        create: { email: req.user.email, passwordHash },
      }),
      prisma.profile.update({ where: { id: req.user.id }, data: { hasPassword: true } }),
    ]);
    res.json({ ok: true });
  })
);

// GET /api/auth/me
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: toPublicProfile(req.user) });
  })
);

function toPublicProfile(profile) {
  const { credential, ...rest } = profile;
  return rest;
}

module.exports = router;
