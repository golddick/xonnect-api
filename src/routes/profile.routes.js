const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { asyncHandler, requireAuth } = require("../middleware/auth");
const { HttpError } = require("../middleware/errorHandler");

const router = express.Router();

const updateSchema = z.object({
  fullName: z.string().min(1).optional(),
  coverImgUrl: z.string().url().optional(),
  avatarUrl: z.string().url().optional(),
  bio: z.string().max(500).optional(),
  website: z.string().url().optional(),
  location: z.string().optional(),
  socialHandles: z.record(z.string()).optional(),
  profileVisibility: z.enum(["public", "private"]).optional(),
  showEmail: z.boolean().optional(),
  showLocation: z.boolean().optional(),
  allowMessages: z.boolean().optional(),
  showOnlineStatus: z.boolean().optional(),
  age: z.number().int().min(13).max(120).optional(),
  sex: z.string().optional(),
});

// GET /api/profile/me
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const profile = await prisma.profile.findUnique({
      where: { id: req.user.id },
      include: { creator: true },
    });
    res.json({ profile: sanitize(profile) });
  })
);

// PUT /api/profile/me
router.put(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const data = updateSchema.parse(req.body);
    const profile = await prisma.profile.update({ where: { id: req.user.id }, data });
    res.json({ profile: sanitize(profile) });
  })
);

// GET /api/profile/:id — respects profileVisibility & per-field toggles
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const profile = await prisma.profile.findUnique({
      where: { id: req.params.id },
      include: { creator: true },
    });
    if (!profile) throw new HttpError(404, "Profile not found");

    if (profile.profileVisibility === "private") {
      throw new HttpError(403, "This profile is private");
    }

    const view = sanitize(profile);
    if (!profile.showEmail) delete view.email;
    if (!profile.showLocation) delete view.location;

    res.json({ profile: view });
  })
);

function sanitize(profile) {
  if (!profile) return profile;
  const { credential, ...rest } = profile;
  return rest;
}

module.exports = router;
