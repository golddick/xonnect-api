const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { asyncHandler, requireAuth } = require("../middleware/auth");
const { HttpError } = require("../middleware/errorHandler");
const { dropid } = require("dropid");

const router = express.Router();

// POST /api/creators/apply — becomes a creator (accepts the creator agreement)
router.post(
  "/apply",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.creator) return res.json({ creator: req.creator });

    const { creatorName } = z.object({ creatorName: z.string().min(1).optional() }).parse(req.body || {});

    const creator = await prisma.$transaction(async (tx) => {
      const created = await tx.creator.create({
        data: { id: dropid("crt"), profileId: req.user.id },
      });
      await tx.profile.update({
        where: { id: req.user.id },
        data: { role: "CREATOR", creatorName: creatorName || req.user.fullName },
      });
      return created;
    });

    res.status(201).json({ creator });
  })
);

// GET /api/creators/:id — public creator profile + basic stats
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const creator = await prisma.creator.findUnique({
      where: { id: req.params.id },
      include: {
        profile: {
          select: {
            id: true,
            fullName: true,
            creatorName: true,
            avatarUrl: true,
            bio: true,
            location: true,
            socialHandles: true,
          },
        },
        _count: { select: { videos: true, events: true } },
      },
    });
    if (!creator) throw new HttpError(404, "Creator not found");
    res.json({ creator });
  })
);

// GET /api/creators/me/summary — for the logged-in creator's dashboard
router.get(
  "/me/summary",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.creator) throw new HttpError(403, "This account is not a creator");

    const [videoCount, eventCount, followerCount, revenueAgg] = await Promise.all([
      prisma.creatorVideo.count({ where: { creatorId: req.creator.id } }),
      prisma.creatorEvent.count({ where: { creatorId: req.creator.id } }),
      prisma.creatorFollow.count({ where: { creatorId: req.creator.id, status: "active" } }),
      prisma.creatorVideo.aggregate({ where: { creatorId: req.creator.id }, _sum: { revenue: true } }),
    ]);

    res.json({
      creator: req.creator,
      summary: {
        videoCount,
        eventCount,
        followerCount,
        totalVideoRevenue: revenueAgg._sum.revenue || 0,
      },
    });
  })
);

// POST /api/creators/:id/follow
router.post(
  "/:id/follow",
  requireAuth,
  asyncHandler(async (req, res) => {
    const creator = await prisma.creator.findUnique({ where: { id: req.params.id } });
    if (!creator) throw new HttpError(404, "Creator not found");

    const follow = await prisma.creatorFollow.upsert({
      where: { followerProfileId_creatorId: { followerProfileId: req.user.id, creatorId: creator.id } },
      update: { status: "active" },
      create: { id: dropid("flw"), creatorId: creator.id, followerProfileId: req.user.id, status: "active" },
    });

    await prisma.creator.update({
      where: { id: creator.id },
      data: { followersCount: { increment: 1 } },
    });

    res.status(201).json({ follow });
  })
);

// DELETE /api/creators/:id/follow
router.delete(
  "/:id/follow",
  requireAuth,
  asyncHandler(async (req, res) => {
    const existing = await prisma.creatorFollow.findUnique({
      where: { followerProfileId_creatorId: { followerProfileId: req.user.id, creatorId: req.params.id } },
    });
    if (!existing || existing.status !== "active") {
      return res.json({ ok: true });
    }

    await prisma.$transaction([
      prisma.creatorFollow.update({ where: { id: existing.id }, data: { status: "inactive" } }),
      prisma.creator.update({ where: { id: req.params.id }, data: { followersCount: { decrement: 1 } } }),
    ]);

    res.json({ ok: true });
  })
);

module.exports = router;
