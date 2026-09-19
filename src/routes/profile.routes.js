const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { asyncHandler, requireAuth } = require("../middleware/auth");
const { HttpError } = require("../middleware/errorHandler");
const cuid = require("cuid");

const router = express.Router();

const updateSchema = z.object({
  fullName: z.string().min(1).nullable().optional(),
  coverImgUrl: z.string().url().nullable().optional(),
  avatarUrl: z.string().url().nullable().optional(),
  bio: z.string().max(500).nullable().optional(),
  website: z.string().url().nullable().optional(),
  location: z.string().nullable().optional(),
  socialHandles: z.record(z.string()).optional(),
  profileVisibility: z.enum(["public", "private"]).optional(),
  showEmail: z.boolean().optional(),
  showLocation: z.boolean().optional(),
  allowMessages: z.boolean().optional(),
  showOnlineStatus: z.boolean().optional(),
  age: z.number().int().min(13).max(120).nullable().optional(),
  sex: z.string().nullable().optional(), 
  addressFull: z.string().nullable().optional(),
  addressLat: z.number().nullable().optional(),
  addressLon: z.number().nullable().optional(),
  addressType: z.string().nullable().optional(),
  addressCountry: z.string().nullable().optional(),
  addressState: z.string().nullable().optional(),
  addressName: z.string().nullable().optional(),
});

async function updateProfile(req, res) {
  const data = updateSchema.parse(req.body);
  const profile = await prisma.profile.update({ where: { id: req.user.id }, data });
  res.json({ profile: sanitize(profile) });
}

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
  asyncHandler(updateProfile)
);

// PUT /api/profile/update — compatibility path used by the web profile form
router.put(
  "/update",
  requireAuth,
  asyncHandler(updateProfile)
);

// GET /api/profile/following — creators followed by the logged-in profile
router.get(
  "/following",
  requireAuth,
  asyncHandler(async (req, res) => {
    const follows = await prisma.creatorFollow.findMany({
      where: { followerProfileId: req.user.id, status: "active" },
      orderBy: { createdAt: "desc" },
      include: {
        creator: {
          include: {
            profile: {
              select: { id: true, fullName: true, creatorName: true, avatarUrl: true, bio: true },
            },
          },
        },
      },
    });

    const creators = follows.map((follow) => follow.creator);
    res.json({ creators, following: creators });
  })
);

// POST /api/profile/follow — toggle a creator follow for the logged-in profile
router.post(
  "/follow",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { creatorId } = z.object({ creatorId: z.string().min(1) }).parse(req.body);
    const creator = await prisma.creator.findUnique({ where: { id: creatorId } });

    if (!creator) throw new HttpError(404, "Creator not found");
    if (creator.profileId === req.user.id) throw new HttpError(400, "You cannot follow yourself");

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.creatorFollow.findUnique({
        where: { followerProfileId_creatorId: { followerProfileId: req.user.id, creatorId } },
      });
      const following = existing?.status !== "active";

      if (existing) {
        await tx.creatorFollow.update({
          where: { id: existing.id },
          data: { status: following ? "active" : "inactive" },
        });
      } else {
        await tx.creatorFollow.create({
          data: { id: cuid(), creatorId, followerProfileId: req.user.id, status: "active" },
        });
      }

      const updatedCreator = await tx.creator.update({
        where: { id: creatorId },
        data: { followersCount: { increment: following ? 1 : -1 } },
        select: { followersCount: true },
      });

      return { following, followersCount: Math.max(0, updatedCreator.followersCount) };
    });

    res.json({ creatorId, ...result });
  })
);

// POST /api/profile/interaction — toggle an event or video like
router.post(
  "/interaction",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { kind, itemId } = z.object({
      kind: z.enum(["event", "video"]),
      itemId: z.string().min(1),
    }).parse(req.body);

    const result = await prisma.$transaction(async (tx) => {
      if (kind === "event") {
        const event = await tx.creatorEvent.findUnique({ where: { id: itemId }, select: { id: true } });
        if (!event) throw new HttpError(404, "Event not found");

        const existing = await tx.creatorEventLike.findUnique({
          where: { creatorEventId_likerProfileId: { creatorEventId: itemId, likerProfileId: req.user.id } },
        });
        const liked = existing?.status !== "active";

        if (existing) {
          await tx.creatorEventLike.update({
            where: { id: existing.id },
            data: { status: liked ? "active" : "inactive" },
          });
        } else {
          await tx.creatorEventLike.create({
            data: { id: cuid(), creatorEventId: itemId, likerProfileId: req.user.id, status: "active" },
          });
        }

        const updatedEvent = await tx.creatorEvent.update({
          where: { id: itemId },
          data: { likesCount: { increment: liked ? 1 : -1 } },
          select: { likesCount: true },
        });

        return { liked, likesCount: Math.max(0, updatedEvent.likesCount) };
      }

      const video = await tx.creatorVideo.findUnique({ where: { id: itemId }, select: { id: true } });
      if (!video) throw new HttpError(404, "Video not found");

      const existing = await tx.creatorVideoLike.findUnique({
        where: { creatorVideoId_likerProfileId: { creatorVideoId: itemId, likerProfileId: req.user.id } },
      });
      const liked = existing?.status !== "active";

      if (existing) {
        await tx.creatorVideoLike.update({
          where: { id: existing.id },
          data: { status: liked ? "active" : "inactive" },
        });
      } else {
        await tx.creatorVideoLike.create({
          data: { id: cuid(), creatorVideoId: itemId, likerProfileId: req.user.id, status: "active" },
        });
      }

      const updatedVideo = await tx.creatorVideo.update({
        where: { id: itemId },
        data: { likesCount: { increment: liked ? 1 : -1 } },
        select: { likesCount: true },
      });

      return { liked, likesCount: Math.max(0, updatedVideo.likesCount) };
    });

    res.json({ kind, itemId, ...result });
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
