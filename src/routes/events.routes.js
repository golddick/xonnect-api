const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { asyncHandler, requireAuth, optionalAuth, requireCreator } = require("../middleware/auth");
const { HttpError } = require("../middleware/errorHandler");
const { dropid } = require("dropid");

const router = express.Router();

const listQuerySchema = z.object({
  category: z.string().optional(),
  search: z.string().optional(),
  status: z.string().optional(),
  creatorId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

// GET /api/events?category=&search=&status=&creatorId=&page=&pageSize=
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { category, search, status, creatorId, page, pageSize } = listQuerySchema.parse(req.query);

    const where = {
      ...(category ? { category } : {}),
      ...(status ? { status } : { isPrivate: false }),
      ...(creatorId ? { creatorId } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: "insensitive" } },
              { description: { contains: search, mode: "insensitive" } },
              { tags: { has: search } },
            ],
          }
        : {}),
    };

    const [events, total] = await Promise.all([
      prisma.creatorEvent.findMany({
        where,
        orderBy: { scheduledAt: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          creator: { include: { profile: { select: { creatorName: true, fullName: true, avatarUrl: true } } } },
          tickets: { where: { status: "ACTIVE" } },
          _count: { select: { likes: true } },
        },
      }),
      prisma.creatorEvent.count({ where }),
    ]);

    res.json({ events, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  })
);

// GET /api/events/:id
router.get(
  "/:id",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const event = await prisma.creatorEvent.findUnique({
      where: { id: req.params.id },
      include: {
        creator: { include: { profile: { select: { creatorName: true, fullName: true, avatarUrl: true, bio: true } } } },
        tickets: true,
        restrictedLocations: true,
      },
    });
    if (!event) throw new HttpError(404, "Event not found");

    let liked = false;
    if (req.user) {
      const like = await prisma.creatorEventLike.findUnique({
        where: { creatorEventId_likerProfileId: { creatorEventId: event.id, likerProfileId: req.user.id } },
      });
      liked = !!like && like.status === "active";
    }

    res.json({ event, liked });
  })
);

const createEventSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  category: z.string().default("music"),
  isPrivate: z.boolean().optional(),
  isPaid: z.boolean().optional(),
  requireTicket: z.boolean().optional(),
  enableDonations: z.boolean().optional(),
  locationName: z.string().optional(),
  locationCountry: z.string().optional(),
  locationState: z.string().optional(),
  address: z.string().optional(),
  thumbnailUrl: z.string().url().optional(),
  scheduledAt: z.coerce.date().optional(),
  durationMinutes: z.number().int().positive().optional(),
  timezone: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

// POST /api/events — creator only
router.post(
  "/",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const data = createEventSchema.parse(req.body);

    const event = await prisma.creatorEvent.create({
      data: {
        id: dropid("evt"),
        creatorId: req.creator.id,
        ...data,
        status: "DRAFT",
      },
    });

    res.status(201).json({ event });
  })
);

const updateEventSchema = createEventSchema.partial().extend({
  status: z.enum(["DRAFT", "SCHEDULED", "LIVE", "PAUSED", "ENDED", "CANCELLED"]).optional(),
});

// PUT /api/events/:id — owning creator only
router.put(
  "/:id",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const existing = await prisma.creatorEvent.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new HttpError(404, "Event not found");
    if (existing.creatorId !== req.creator.id) throw new HttpError(403, "You don't own this event");

    const data = updateEventSchema.parse(req.body);
    const event = await prisma.creatorEvent.update({ where: { id: req.params.id }, data });
    res.json({ event });
  })
);

// DELETE /api/events/:id — owning creator only
router.delete(
  "/:id",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const existing = await prisma.creatorEvent.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new HttpError(404, "Event not found");
    if (existing.creatorId !== req.creator.id) throw new HttpError(403, "You don't own this event");

    await prisma.creatorEvent.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);

// POST /api/events/:id/like
router.post(
  "/:id/like",
  requireAuth,
  asyncHandler(async (req, res) => {
    const event = await prisma.creatorEvent.findUnique({ where: { id: req.params.id } });
    if (!event) throw new HttpError(404, "Event not found");

    const like = await prisma.creatorEventLike.upsert({
      where: { creatorEventId_likerProfileId: { creatorEventId: event.id, likerProfileId: req.user.id } },
      update: { status: "active" },
      create: { id: dropid("lik"), creatorEventId: event.id, likerProfileId: req.user.id },
    });

    await prisma.creatorEvent.update({ where: { id: event.id }, data: { likesCount: { increment: 1 } } });
    res.status(201).json({ like });
  })
);

// DELETE /api/events/:id/like
router.delete(
  "/:id/like",
  requireAuth,
  asyncHandler(async (req, res) => {
    const existing = await prisma.creatorEventLike.findUnique({
      where: { creatorEventId_likerProfileId: { creatorEventId: req.params.id, likerProfileId: req.user.id } },
    });
    if (!existing || existing.status !== "active") return res.json({ ok: true });

    await prisma.$transaction([
      prisma.creatorEventLike.update({ where: { id: existing.id }, data: { status: "inactive" } }),
      prisma.creatorEvent.update({ where: { id: req.params.id }, data: { likesCount: { decrement: 1 } } }),
    ]);
    res.json({ ok: true });
  })
);

module.exports = router;
