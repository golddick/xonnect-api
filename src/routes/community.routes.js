const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { asyncHandler, requireAuth, optionalAuth, requireCreator } = require("../middleware/auth");
const { HttpError } = require("../middleware/errorHandler");
const { dropid } = require("dropid");

const router = express.Router();

const createCommunitySchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  bannerUrl: z.string().url().optional(),
  iconUrl: z.string().url().optional(),
  isPrivate: z.boolean().optional(),
});

// POST /api/community — creator only, and only once (unique creatorId enforces "1 community per creator")
router.post(
  "/",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const existing = await prisma.community.findUnique({ where: { creatorId: req.creator.id } });
    if (existing) throw new HttpError(409, "You already have a community — every creator can only have one");

    const data = createCommunitySchema.parse(req.body);

    const community = await prisma.$transaction(async (tx) => {
      const created = await tx.community.create({
        data: { id: dropid("cmy"), creatorId: req.creator.id, ...data },
      });
      // Creator is automatically the first (owner) member.
      await tx.communityMember.create({
        data: { id: dropid("cmm"), communityId: created.id, profileId: req.user.id, role: "owner" },
      });
      return tx.community.update({ where: { id: created.id }, data: { membersCount: 1 } });
    });

    res.status(201).json({ community });
  })
);

const listCommunitiesSchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

// GET /api/community — public discovery list (search by name), public communities only
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { search, page, pageSize } = listCommunitiesSchema.parse(req.query);
    const where = {
      isPrivate: false,
      ...(search ? { name: { contains: search, mode: "insensitive" } } : {}),
    };

    const [communities, total] = await Promise.all([
      prisma.community.findMany({
        where,
        orderBy: { membersCount: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          creator: { include: { profile: { select: { creatorName: true, fullName: true, avatarUrl: true } } } },
        },
      }),
      prisma.community.count({ where }),
    ]);

    res.json({ communities, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  })
);

// GET /api/community/mine — communities the logged-in user is an active member of (includes their own, if a creator)
router.get(
  "/mine",
  requireAuth,
  asyncHandler(async (req, res) => {
    const memberships = await prisma.communityMember.findMany({
      where: { profileId: req.user.id, status: "active" },
      include: {
        community: {
          include: { creator: { include: { profile: { select: { creatorName: true, fullName: true, avatarUrl: true } } } } },
        },
      },
    });
    res.json({ communities: memberships.map((m) => ({ ...m.community, myRole: m.role })) });
  })
);

// GET /api/community/:id
router.get(
  "/:id",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const community = await prisma.community.findUnique({
      where: { id: req.params.id },
      include: {
        creator: { include: { profile: { select: { creatorName: true, fullName: true, avatarUrl: true } } } },
      },
    });
    if (!community) throw new HttpError(404, "Community not found");

    let isMember = false;
    if (req.user) {
      const membership = await prisma.communityMember.findUnique({
        where: { communityId_profileId: { communityId: community.id, profileId: req.user.id } },
      });
      isMember = !!membership && membership.status === "active";
    }

    res.json({ community, isMember });
  })
);

// GET /api/creators/:creatorId/community — convenience lookup by creator
router.get(
  "/by-creator/:creatorId",
  asyncHandler(async (req, res) => {
    const community = await prisma.community.findUnique({ where: { creatorId: req.params.creatorId } });
    if (!community) throw new HttpError(404, "This creator doesn't have a community yet");
    res.json({ community });
  })
);

const updateCommunitySchema = createCommunitySchema.partial();

// PUT /api/community/:id — owning creator only
router.put(
  "/:id",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const community = await prisma.community.findUnique({ where: { id: req.params.id } });
    if (!community) throw new HttpError(404, "Community not found");
    if (community.creatorId !== req.creator.id) throw new HttpError(403, "You don't own this community");

    const data = updateCommunitySchema.parse(req.body);
    const updated = await prisma.community.update({ where: { id: community.id }, data });
    res.json({ community: updated });
  })
);

// POST /api/community/:id/join
router.post(
  "/:id/join",
  requireAuth,
  asyncHandler(async (req, res) => {
    const community = await prisma.community.findUnique({ where: { id: req.params.id } });
    if (!community) throw new HttpError(404, "Community not found");

    const existing = await prisma.communityMember.findUnique({
      where: { communityId_profileId: { communityId: community.id, profileId: req.user.id } },
    });

    if (existing && existing.status === "active") {
      return res.json({ membership: existing });
    }

    const membership = await prisma.$transaction(async (tx) => {
      const m = existing
        ? await tx.communityMember.update({ where: { id: existing.id }, data: { status: "active" } })
        : await tx.communityMember.create({
            data: { id: dropid("cmm"), communityId: community.id, profileId: req.user.id },
          });
      await tx.community.update({ where: { id: community.id }, data: { membersCount: { increment: 1 } } });
      return m;
    });

    res.status(201).json({ membership });
  })
);

// DELETE /api/community/:id/join — leave the community
router.delete(
  "/:id/join",
  requireAuth,
  asyncHandler(async (req, res) => {
    const existing = await prisma.communityMember.findUnique({
      where: { communityId_profileId: { communityId: req.params.id, profileId: req.user.id } },
    });
    if (!existing || existing.status !== "active") return res.json({ ok: true });

    if (existing.role === "owner") {
      throw new HttpError(400, "The creator can't leave their own community");
    }

    await prisma.$transaction([
      prisma.communityMember.update({ where: { id: existing.id }, data: { status: "left" } }),
      prisma.community.update({ where: { id: req.params.id }, data: { membersCount: { decrement: 1 } } }),
    ]);

    res.json({ ok: true });
  })
);

const listMembersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(30),
});

// GET /api/community/:id/members
router.get(
  "/:id/members",
  asyncHandler(async (req, res) => {
    const { page, pageSize } = listMembersSchema.parse(req.query);
    const [members, total] = await Promise.all([
      prisma.communityMember.findMany({
        where: { communityId: req.params.id, status: "active" },
        orderBy: { joinedAt: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { profile: { select: { id: true, fullName: true, avatarUrl: true } } },
      }),
      prisma.communityMember.count({ where: { communityId: req.params.id, status: "active" } }),
    ]);
    res.json({ members, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  })
);

const listPostsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

// GET /api/community/:id/posts
router.get(
  "/:id/posts",
  asyncHandler(async (req, res) => {
    const { page, pageSize } = listPostsSchema.parse(req.query);
    const [posts, total] = await Promise.all([
      prisma.communityPost.findMany({
        where: { communityId: req.params.id },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { authorProfile: { select: { fullName: true, avatarUrl: true } } },
      }),
      prisma.communityPost.count({ where: { communityId: req.params.id } }),
    ]);
    res.json({ posts, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  })
);

const createPostSchema = z.object({
  content: z.string().min(1).max(2000),
  imageUrl: z.string().url().optional(),
});

// POST /api/community/:id/posts — must be an active member (owner included) to post
router.post(
  "/:id/posts",
  requireAuth,
  asyncHandler(async (req, res) => {
    const membership = await prisma.communityMember.findUnique({
      where: { communityId_profileId: { communityId: req.params.id, profileId: req.user.id } },
    });
    if (!membership || membership.status !== "active") {
      throw new HttpError(403, "Join this community before posting");
    }

    const data = createPostSchema.parse(req.body);
    const post = await prisma.$transaction(async (tx) => {
      const created = await tx.communityPost.create({
        data: { id: dropid("cmp"), communityId: req.params.id, authorProfileId: req.user.id, ...data },
      });
      await tx.community.update({ where: { id: req.params.id }, data: { postsCount: { increment: 1 } } });
      return created;
    });

    res.status(201).json({ post });
  })
);

module.exports = router;
