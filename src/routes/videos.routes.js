const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { asyncHandler, requireAuth, optionalAuth, requireCreator } = require("../middleware/auth");
const { HttpError } = require("../middleware/errorHandler");
const paystack = require("../lib/paystack");
const { dropid } = require("dropid");

const router = express.Router();

const createFolderSchema = z.object({
  title: z.string().min(1),
  folderType: z.string().default("general"),
});

// POST /api/videos/folders — creator only, videos must belong to a folder
router.post(
  "/folders",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const data = createFolderSchema.parse(req.body);
    const folder = await prisma.creatorVideoFolder.create({
      data: { id: dropid("fld"), creatorId: req.creator.id, ...data },
    });
    res.status(201).json({ folder });
  })
);

// GET /api/videos/folders/mine
router.get(
  "/folders/mine",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const folders = await prisma.creatorVideoFolder.findMany({
      where: { creatorId: req.creator.id },
      orderBy: { createdAt: "desc" },
    });
    res.json({ folders });
  })
);

const listQuerySchema = z.object({
  category: z.string().optional(),
  creatorId: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

// GET /api/videos
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { category, creatorId, search, page, pageSize } = listQuerySchema.parse(req.query);

    const where = {
      status: "published",
      isPrivate: false,
      ...(category ? { category } : {}),
      ...(creatorId ? { creatorId } : {}),
      ...(search ? { title: { contains: search, mode: "insensitive" } } : {}),
    };

    const [videos, total] = await Promise.all([
      prisma.creatorVideo.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          creator: { include: { profile: { select: { creatorName: true, fullName: true, avatarUrl: true } } } },
        },
      }),
      prisma.creatorVideo.count({ where }),
    ]);

    res.json({ videos, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  })
);

// GET /api/videos/:id
router.get(
  "/:id",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const video = await prisma.creatorVideo.findUnique({
      where: { id: req.params.id },
      include: {
        creator: { include: { profile: { select: { creatorName: true, fullName: true, avatarUrl: true } } } },
        comments: { where: { parentCommentId: null }, orderBy: { createdAt: "desc" }, take: 20, include: { replies: true } },
      },
    });
    if (!video) throw new HttpError(404, "Video not found");

    prisma.creatorVideoView
      .create({ data: { id: id("vw"), creatorVideoId: video.id, viewerProfileId: req.user?.id } })
      .then(() => prisma.creatorVideo.update({ where: { id: video.id }, data: { viewsCount: { increment: 1 } } }))
      .catch(() => {});

    let hasAccess = !video.isPremium;
    if (req.user && video.isPremium) {
      const purchase = await prisma.creatorVideoPurchase.findFirst({
        where: { creatorVideoId: video.id, buyerProfileId: req.user.id, status: "COMPLETED" },
      });
      hasAccess = !!purchase;
    }

    res.json({ video, hasAccess });
  })
);

const createVideoSchema = z.object({
  folderId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  videoUrl: z.string().url().optional(),
  thumbnailUrl: z.string().url().optional(),
  isPremium: z.boolean().optional(),
  monetizationType: z.enum(["free", "rent", "purchase"]).optional(),
  rent24Price: z.number().int().min(0).optional(),
  rent48Price: z.number().int().min(0).optional(),
  purchasePrice: z.number().int().min(0).optional(),
  tags: z.array(z.string()).optional(),
});

// POST /api/videos — creator uploads video metadata (actual file goes to storage/CDN separately)
router.post(
  "/",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const data = createVideoSchema.parse(req.body);

    const folder = await prisma.creatorVideoFolder.findUnique({ where: { id: data.folderId } });
    if (!folder || folder.creatorId !== req.creator.id) throw new HttpError(404, "Folder not found");

    const video = await prisma.creatorVideo.create({
      data: { id: dropid("vid"), creatorId: req.creator.id, ...data },
    });

    res.status(201).json({ video });
  })
);

const purchaseSchema = z.object({
  purchaseType: z.enum(["rent24", "rent48", "purchase"]),
});

// POST /api/videos/:id/purchase/initialize
// Creates a PENDING purchase and starts a Paystack transaction; completion happens via
// the /api/payments/paystack/webhook handler once payment is confirmed.
router.post(
  "/:id/purchase/initialize",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { purchaseType } = purchaseSchema.parse(req.body);

    const video = await prisma.creatorVideo.findUnique({ where: { id: req.params.id } });
    if (!video) throw new HttpError(404, "Video not found");

    const priceMap = { rent24: video.rent24Price, rent48: video.rent48Price, purchase: video.purchasePrice };
    const amount = priceMap[purchaseType];
    if (amount == null) throw new HttpError(400, `This video does not support "${purchaseType}"`);

    const expiryHours = purchaseType === "rent24" ? 24 : purchaseType === "rent48" ? 48 : null;
    const reference = dropid("txn");

    const purchase = await prisma.creatorVideoPurchase.create({
      data: {
        id: dropid("vpu"),
        creatorId: video.creatorId,
        creatorVideoId: video.id,
        buyerProfileId: req.user.id,
        buyerEmail: req.user.email,
        purchaseType,
        amount,
        transactionId: reference,
        status: "PENDING",
        accessExpiresAt: expiryHours ? new Date(Date.now() + expiryHours * 60 * 60 * 1000) : null,
      },
    });

    if (amount === 0) {
      const completed = await completeVideoPurchase(purchase.id);
      return res.status(201).json({ purchase: completed, free: true });
    }

    const paystackTx = await paystack.initializeTransaction({
      email: req.user.email,
      amountKobo: amount * 100,
      reference,
      callbackUrl: `${process.env.APP_BASE_URL}/payments/callback`,
      metadata: { type: "video", purchaseId: purchase.id, videoId: video.id },
    });

    res.status(201).json({ purchase, authorizationUrl: paystackTx.authorization_url, reference });
  })
);

/**
 * Marks a PENDING video purchase COMPLETED using the creator's *current*
 * videoPayoutPercent, and unlocks access via `accessCode`.
 * Exported so the Paystack webhook handler (payments.routes.js) can call it too.
 */
async function completeVideoPurchase(purchaseId) {
  return prisma.$transaction(async (tx) => {
    const purchase = await tx.creatorVideoPurchase.findUnique({
      where: { id: purchaseId },
      include: { creator: true },
    });
    if (!purchase) throw new HttpError(404, "Purchase not found");
    if (purchase.status === "COMPLETED") return purchase; // idempotent

    const payoutPct = purchase.creator.videoPayoutPercent;
    const revenue = Math.round((purchase.amount * payoutPct) / 100);
    const platformFee = purchase.amount - revenue;

    const updated = await tx.creatorVideoPurchase.update({
      where: { id: purchase.id },
      data: {
        status: "COMPLETED",
        revenue,
        platformFee,
        accessCode: dropid("acc"),
        completedAt: new Date(),
      },
    });

    await tx.creatorVideo.update({
      where: { id: purchase.creatorVideoId },
      data: {
        revenue: { increment: revenue },
        amount: { increment: purchase.amount },
        platformFee: { increment: platformFee },
      },
    });

    return updated;
  });
}

// POST /api/videos/:id/like
router.post(
  "/:id/like",
  requireAuth,
  asyncHandler(async (req, res) => {
    const video = await prisma.creatorVideo.findUnique({ where: { id: req.params.id } });
    if (!video) throw new HttpError(404, "Video not found");

    await prisma.creatorVideoLike.upsert({
      where: { creatorVideoId_likerProfileId: { creatorVideoId: video.id, likerProfileId: req.user.id } },
      update: { status: "active" },
      create: { id: dropid("lik"), creatorVideoId: video.id, likerProfileId: req.user.id },
    });
    await prisma.creatorVideo.update({ where: { id: video.id }, data: { likesCount: { increment: 1 } } });

    res.status(201).json({ ok: true });
  })
);

const commentSchema = z.object({
  content: z.string().min(1).max(1000),
  parentCommentId: z.string().optional(),
});

// POST /api/videos/:id/comments
router.post(
  "/:id/comments",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { content, parentCommentId } = commentSchema.parse(req.body);
    const video = await prisma.creatorVideo.findUnique({ where: { id: req.params.id } });
    if (!video) throw new HttpError(404, "Video not found");
    if (!video.allowComments) throw new HttpError(403, "Comments are disabled for this video");

    const comment = await prisma.creatorVideoComment.create({
      data: {
        id: dropid("cmt"),
        creatorVideoId: video.id,
        commenterProfileId: req.user.id,
        commenterEmail: req.user.email,
        content,
        parentCommentId,
      },
    });
    await prisma.creatorVideo.update({ where: { id: video.id }, data: { commentsCount: { increment: 1 } } });

    res.status(201).json({ comment });
  })
);

module.exports = router;
module.exports.completeVideoPurchase = completeVideoPurchase;




// const express = require("express");
// const { z } = require("zod");
// const prisma = require("../lib/prisma");
// const { asyncHandler, requireAuth, optionalAuth, requireCreator } = require("../middleware/auth");
// const { HttpError } = require("../middleware/errorHandler");
// const paystack = require("../lib/paystack");
// const { dropid } = require("dropid");

// const router = express.Router();

// const listQuerySchema = z.object({
//   category: z.string().optional(),
//   creatorId: z.string().optional(),
//   search: z.string().optional(),
//   page: z.coerce.number().int().min(1).default(1),
//   pageSize: z.coerce.number().int().min(1).max(50).default(20),
// });

// // GET /api/videos
// router.get(
//   "/",
//   asyncHandler(async (req, res) => {
//     const { category, creatorId, search, page, pageSize } = listQuerySchema.parse(req.query);

//     const where = {
//       status: "published",
//       isPrivate: false,
//       ...(category ? { category } : {}),
//       ...(creatorId ? { creatorId } : {}),
//       ...(search ? { title: { contains: search, mode: "insensitive" } } : {}),
//     };

//     const [videos, total] = await Promise.all([
//       prisma.creatorVideo.findMany({
//         where,
//         orderBy: { createdAt: "desc" },
//         skip: (page - 1) * pageSize,
//         take: pageSize,
//         include: {
//           creator: { include: { profile: { select: { creatorName: true, fullName: true, avatarUrl: true } } } },
//         },
//       }),
//       prisma.creatorVideo.count({ where }),
//     ]);

//     res.json({ videos, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
//   })
// );

// // GET /api/videos/:id
// router.get(
//   "/:id",
//   optionalAuth,
//   asyncHandler(async (req, res) => {
//     const video = await prisma.creatorVideo.findUnique({
//       where: { id: req.params.id },
//       include: {
//         creator: { include: { profile: { select: { creatorName: true, fullName: true, avatarUrl: true } } } },
//         comments: { where: { parentCommentId: null }, orderBy: { createdAt: "desc" }, take: 20, include: { replies: true } },
//       },
//     });
//     if (!video) throw new HttpError(404, "Video not found");

//     prisma.creatorVideoView
//       .create({ data: { id: dropid("vw"), creatorVideoId: video.id, viewerProfileId: req.user?.id } })
//       .then(() => prisma.creatorVideo.update({ where: { id: video.id }, data: { viewsCount: { increment: 1 } } }))
//       .catch(() => {});

//     let hasAccess = !video.isPremium;
//     if (req.user && video.isPremium) {
//       const purchase = await prisma.creatorVideoPurchase.findFirst({
//         where: { creatorVideoId: video.id, buyerProfileId: req.user.id, status: "COMPLETED" },
//       });
//       hasAccess = !!purchase;
//     }

//     res.json({ video, hasAccess });
//   })
// );

// const createVideoSchema = z.object({
//   folderId: z.string().min(1),
//   title: z.string().min(1),
//   description: z.string().optional(),
//   category: z.string().optional(),
//   videoUrl: z.string().url().optional(),
//   thumbnailUrl: z.string().url().optional(),
//   isPremium: z.boolean().optional(),
//   monetizationType: z.enum(["free", "rent", "purchase"]).optional(),
//   rent24Price: z.number().int().min(0).optional(),
//   rent48Price: z.number().int().min(0).optional(),
//   purchasePrice: z.number().int().min(0).optional(),
//   tags: z.array(z.string()).optional(),
// });

// // POST /api/videos — creator uploads video metadata (actual file goes to storage/CDN separately)
// router.post(
//   "/",
//   requireAuth,
//   requireCreator,
//   asyncHandler(async (req, res) => {
//     const data = createVideoSchema.parse(req.body);

//     const folder = await prisma.creatorVideoFolder.findUnique({ where: { id: data.folderId } });
//     if (!folder || folder.creatorId !== req.creator.id) throw new HttpError(404, "Folder not found");

//     const video = await prisma.creatorVideo.create({
//       data: { id: dropid("vid"), creatorId: req.creator.id, ...data },
//     });

//     res.status(201).json({ video });
//   })
// );

// const purchaseSchema = z.object({
//   purchaseType: z.enum(["rent24", "rent48", "purchase"]),
// });

// // POST /api/videos/:id/purchase/initialize
// // Creates a PENDING purchase and starts a Paystack transaction; completion happens via
// // the /api/payments/paystack/webhook handler once payment is confirmed.
// router.post(
//   "/:id/purchase/initialize",
//   requireAuth,
//   asyncHandler(async (req, res) => {
//     const { purchaseType } = purchaseSchema.parse(req.body);

//     const video = await prisma.creatorVideo.findUnique({ where: { id: req.params.id } });
//     if (!video) throw new HttpError(404, "Video not found");

//     const priceMap = { rent24: video.rent24Price, rent48: video.rent48Price, purchase: video.purchasePrice };
//     const amount = priceMap[purchaseType];
//     if (amount == null) throw new HttpError(400, `This video does not support "${purchaseType}"`);

//     const expiryHours = purchaseType === "rent24" ? 24 : purchaseType === "rent48" ? 48 : null;
//     const reference = dropid("txn");

//     const purchase = await prisma.creatorVideoPurchase.create({
//       data: {
//         id: dropid("vpu"),
//         creatorId: video.creatorId,
//         creatorVideoId: video.id,
//         buyerProfileId: req.user.id,
//         buyerEmail: req.user.email,
//         purchaseType,
//         amount,
//         transactionId: reference,
//         status: "PENDING",
//         accessExpiresAt: expiryHours ? new Date(Date.now() + expiryHours * 60 * 60 * 1000) : null,
//       },
//     });

//     if (amount === 0) {
//       const completed = await completeVideoPurchase(purchase.id);
//       return res.status(201).json({ purchase: completed, free: true });
//     }

//     const paystackTx = await paystack.initializeTransaction({
//       email: req.user.email,
//       amountKobo: amount * 100,
//       reference,
//       callbackUrl: `${process.env.APP_BASE_URL}/payments/callback`,
//       metadata: { type: "video", purchaseId: purchase.id, videoId: video.id },
//     });

//     res.status(201).json({ purchase, authorizationUrl: paystackTx.authorization_url, reference });
//   })
// );

// /**
//  * Marks a PENDING video purchase COMPLETED using the creator's *current*
//  * videoPayoutPercent, and unlocks access via `accessCode`.
//  * Exported so the Paystack webhook handler (payments.routes.js) can call it too.
//  */
// async function completeVideoPurchase(purchaseId) {
//   return prisma.$transaction(async (tx) => {
//     const purchase = await tx.creatorVideoPurchase.findUnique({
//       where: { id: purchaseId },
//       include: { creator: true },
//     });
//     if (!purchase) throw new HttpError(404, "Purchase not found");
//     if (purchase.status === "COMPLETED") return purchase; // idempotent

//     const payoutPct = purchase.creator.videoPayoutPercent;
//     const revenue = Math.round((purchase.amount * payoutPct) / 100);
//     const platformFee = purchase.amount - revenue;

//     const updated = await tx.creatorVideoPurchase.update({
//       where: { id: purchase.id },
//       data: {
//         status: "COMPLETED",
//         revenue,
//         platformFee,
//         accessCode: dropid("acc"),
//         completedAt: new Date(),
//       },
//     });

//     await tx.creatorVideo.update({
//       where: { id: purchase.creatorVideoId },
//       data: {
//         revenue: { increment: revenue },
//         amount: { increment: purchase.amount },
//         platformFee: { increment: platformFee },
//       },
//     });

//     return updated;
//   });
// }

// // POST /api/videos/:id/like
// router.post(
//   "/:id/like",
//   requireAuth,
//   asyncHandler(async (req, res) => {
//     const video = await prisma.creatorVideo.findUnique({ where: { id: req.params.id } });
//     if (!video) throw new HttpError(404, "Video not found");

//     await prisma.creatorVideoLike.upsert({
//       where: { creatorVideoId_likerProfileId: { creatorVideoId: video.id, likerProfileId: req.user.id } },
//       update: { status: "active" },
//       create: { id: dropid("lik"), creatorVideoId: video.id, likerProfileId: req.user.id },
//     });
//     await prisma.creatorVideo.update({ where: { id: video.id }, data: { likesCount: { increment: 1 } } });

//     res.status(201).json({ ok: true });
//   })
// );

// const commentSchema = z.object({
//   content: z.string().min(1).max(1000),
//   parentCommentId: z.string().optional(),
// });

// // POST /api/videos/:id/comments
// router.post(
//   "/:id/comments",
//   requireAuth,
//   asyncHandler(async (req, res) => {
//     const { content, parentCommentId } = commentSchema.parse(req.body);
//     const video = await prisma.creatorVideo.findUnique({ where: { id: req.params.id } });
//     if (!video) throw new HttpError(404, "Video not found");
//     if (!video.allowComments) throw new HttpError(403, "Comments are disabled for this video");

//     const comment = await prisma.creatorVideoComment.create({
//       data: {
//         id: dropid("cmt"),
//         creatorVideoId: video.id,
//         commenterProfileId: req.user.id,
//         commenterEmail: req.user.email,
//         content,
//         parentCommentId,
//       },
//     });
//     await prisma.creatorVideo.update({ where: { id: video.id }, data: { commentsCount: { increment: 1 } } });

//     res.status(201).json({ comment });
//   })
// );

// module.exports = router;
// module.exports.completeVideoPurchase = completeVideoPurchase;
