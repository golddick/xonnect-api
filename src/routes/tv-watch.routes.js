const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { asyncHandler, optionalAuth } = require("../middleware/auth");
const { HttpError } = require("../middleware/errorHandler");
const paystack = require("../lib/paystack");
const { dropid } = require("dropid");
const { completeVideoPurchase } = require("./videos.routes");

const router = express.Router();

function initials(value) {
  const parts = String(value || "TV").trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? `${parts[0][0]}${parts[1][0]}`.toUpperCase() : parts[0].slice(0, 2).toUpperCase();
}

function creatorSelect() {
  return { profile: { select: { id: true, fullName: true, creatorName: true, avatarUrl: true, socialHandles: true } }, followersCount: true, followingCount: true };
}

function serializeComment(comment) {
  return {
    id: comment.id,
    author: comment.commenterProfile?.fullName || comment.commenterEmail || "Unknown",
    authorEmail: comment.commenterEmail,
    text: comment.content,
    likes: 0,
    replies: (comment.replies || []).map(serializeComment),
  };
}

async function accessForVideos(videos, req, accessCode) {
  const profileId = req.user?.id;
  const email = req.user?.email?.toLowerCase();
  const purchases = profileId || email
    ? await prisma.creatorVideoPurchase.findMany({
        where: {
          creatorVideoId: { in: videos.map((video) => video.id) },
          status: "COMPLETED",
          OR: [{ buyerProfileId: profileId || undefined }, { buyerEmail: email || undefined }],
        },
        select: { creatorVideoId: true, accessCode: true, accessExpiresAt: true, purchaseType: true },
      })
    : [];
  const map = new Map();
  let codeVideoId = null;
  for (const purchase of purchases) {
    if (purchase.accessExpiresAt && purchase.accessExpiresAt <= new Date()) continue;
    map.set(purchase.creatorVideoId, purchase);
    if (accessCode && purchase.accessCode === accessCode) codeVideoId = purchase.creatorVideoId;
  }
  return { map, codeVideoId };
}

function serializePart(video, access, canBypass) {
  const free = !video.isPremium || video.monetizationType === "free";
  const timed = access?.purchaseType === "purchase" || Boolean(access && (!access.accessExpiresAt || access.accessExpiresAt > new Date()));
  const canView = canBypass || free || timed;
  const previewOnly = !canView && Boolean(video.videoUrl);
  return {
    id: video.id,
    title: video.title,
    description: video.description,
    duration: video.duration,
    views: video.viewsCount,
    likes: video.likesCount,
    comments: video.commentsCount,
    revenue: video.revenue,
    thumbnail: video.thumbnailUrl,
    videoUrl: video.videoUrl,
    episodeIndex: video.episodeIndex,
    status: video.status,
    category: video.category,
    uploadDate: video.createdAt,
    monetizationType: video.monetizationType,
    isPrivate: video.isPrivate,
    isPremium: video.isPremium,
    allowComments: video.allowComments,
    rent24Price: video.rent24Price,
    rent48Price: video.rent48Price,
    purchasePrice: video.purchasePrice,
    tags: video.tags,
    packageName: video.packageName,
    isLocked: !canView && !previewOnly,
    previewOnly,
    accessExpiresAt: access?.accessExpiresAt?.toISOString() || null,
  };
}

router.get("/folder/:id", optionalAuth, asyncHandler(async (req, res) => {
  const folder = await prisma.creatorVideoFolder.findUnique({
    where: { id: req.params.id },
    include: {
      creator: { select: creatorSelect() },
      videos: { orderBy: [{ episodeIndex: "asc" }, { createdAt: "asc" }] },
    },
  });
  if (!folder || folder.status !== "active") throw new HttpError(404, "Folder not found");

  const access = await accessForVideos(folder.videos, req, String(req.query.accessCode || "").trim());
  const profileId = req.user?.id;
  const creatorName = folder.creator.profile.fullName || folder.creator.profile.creatorName || "Xonnect Creator";
  const parts = folder.videos.map((video) => serializePart(video, access.map.get(video.id), false));
  const following = profileId
    ? await prisma.creatorFollow.findFirst({ where: { creatorId: folder.creatorId, followerProfileId: profileId, status: "active" } })
    : null;

  res.json({
    kind: "folder",
    folder: {
      id: folder.id,
      title: folder.title,
      contentType: folder.folderType,
      status: folder.status,
      thumbnail: folder.thumbnailUrl,
      uploadDate: folder.createdAt,
      description: null,
      creator: {
        id: folder.creatorId,
        name: creatorName,
        avatarUrl: folder.creator.profile.avatarUrl,
        avatarInitials: initials(creatorName),
        socialHandles: Array.isArray(folder.creator.profile.socialHandles) ? folder.creator.profile.socialHandles : [],
        followersCount: folder.creator.followersCount,
        followingCount: folder.creator.followingCount,
        isFollowing: Boolean(following),
        isSelf: profileId === folder.creator.profile.id,
      },
      parts,
      access: {
        locked: parts.length > 0 && parts.every((part) => part.isLocked),
        accessCodeProvided: Boolean(req.query.accessCode),
        canUseAccessCode: Boolean(req.user),
        requiresSignIn: !req.user,
        loggedIn: Boolean(req.user),
        canBypassAccess: false,
        unlockedParts: parts.filter((part) => !part.isLocked).length,
        codeVideoId: access.codeVideoId,
      },
    },
  });
}));

router.get("/event/:id", optionalAuth, asyncHandler(async (req, res) => {
  const event = await prisma.creatorEvent.findUnique({
    where: { id: req.params.id },
    include: { creator: { select: creatorSelect() }, tickets: { where: { status: "ACTIVE" }, orderBy: { price: "asc" } } },
  });
  if (!event || event.isPrivate) throw new HttpError(404, "Event not found");
  const creatorName = event.creator.profile.fullName || event.creator.profile.creatorName || "Xonnect Creator";
  const hasStreamAccess = !event.isPaid && !event.requireTicket;
  res.json({
    kind: "event",
    event: {
      ...event,
      creator: { ...event.creator, name: creatorName, isFollowing: false },
      access: { locked: !hasStreamAccess, loggedIn: Boolean(req.user), accessExpiresAt: null },
    },
  });
}));

router.get("/comments/:videoId", asyncHandler(async (req, res) => {
  const comments = await prisma.creatorVideoComment.findMany({
    where: { creatorVideoId: req.params.videoId, parentCommentId: null },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { commenterProfile: true, replies: { include: { commenterProfile: true }, orderBy: { createdAt: "asc" } } },
  });
  res.json({ comments: comments.map(serializeComment) });
}));

router.post("/comments/:videoId", optionalAuth, asyncHandler(async (req, res) => {
  const body = z.object({ text: z.string().trim().min(1).max(1000), authorEmail: z.string().email().optional(), parentCommentId: z.string().nullable().optional() }).parse(req.body);
  const video = await prisma.creatorVideo.findUnique({ where: { id: req.params.videoId } });
  if (!video) throw new HttpError(404, "Video not found");
  const comment = await prisma.creatorVideoComment.create({
    data: { id: dropid("cmt"), creatorVideoId: video.id, commenterProfileId: req.user?.id, commenterEmail: req.user?.email || body.authorEmail, content: body.text, parentCommentId: body.parentCommentId || undefined },
  });
  await prisma.creatorVideo.update({ where: { id: video.id }, data: { commentsCount: { increment: 1 } } });
  res.status(201).json({ comment: serializeComment(comment) });
}));

router.patch("/comments/:videoId", asyncHandler(async (req, res) => {
  const { commentId } = z.object({ commentId: z.string(), like: z.boolean() }).parse(req.body);
  const comment = await prisma.creatorVideoComment.findFirst({ where: { id: commentId, creatorVideoId: req.params.videoId } });
  if (!comment) throw new HttpError(404, "Comment not found");
  res.json({ ok: true });
}));

router.post("/:videoId/purchase", asyncHandler(async (req, res) => {
  const body = z.object({ purchaseType: z.enum(["rent24", "rent48", "purchase"]), buyerName: z.string().min(1), buyerEmail: z.string().email(), buyerPhone: z.string().optional() }).parse(req.body);
  const video = await prisma.creatorVideo.findUnique({ where: { id: req.params.videoId } });
  if (!video) throw new HttpError(404, "Video not found");
  const amount = { rent24: video.rent24Price, rent48: video.rent48Price, purchase: video.purchasePrice }[body.purchaseType];
  if (amount == null) throw new HttpError(400, "This video does not support that purchase type");
  const reference = dropid("txn");
  const expiryHours = body.purchaseType === "rent24" ? 24 : body.purchaseType === "rent48" ? 48 : null;
  const purchase = await prisma.creatorVideoPurchase.create({
    data: {
      id: dropid("vpu"),
      creatorId: video.creatorId,
      creatorVideoId: video.id,
      buyerName: body.buyerName,
      buyerEmail: body.buyerEmail,
      buyerPhone: body.buyerPhone,
      purchaseType: body.purchaseType,
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
  const payment = await paystack.initializeTransaction({
    email: body.buyerEmail,
    amountKobo: amount * 100,
    reference,
    callbackUrl: `${process.env.APP_BASE_URL}/payments/callback`,
    metadata: { type: "video", purchaseId: purchase.id, videoId: video.id },
  });
  res.status(201).json({ purchase, authorizationUrl: payment.authorization_url, reference });
}));

router.post("/:videoId/view", optionalAuth, asyncHandler(async (req, res) => {
  const video = await prisma.creatorVideo.findUnique({ where: { id: req.params.videoId }, select: { id: true } });
  if (!video) throw new HttpError(404, "Video not found");
  await prisma.$transaction([
    prisma.creatorVideoView.create({ data: { id: dropid("vw"), creatorVideoId: video.id, viewerProfileId: req.user?.id } }),
    prisma.creatorVideo.update({ where: { id: video.id }, data: { viewsCount: { increment: 1 } } }),
  ]);
  res.json({ ok: true });
}));

module.exports = router;