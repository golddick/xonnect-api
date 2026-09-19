const express = require("express");
const { z } = require("zod");
const { dropid } = require("dropid");
const prisma = require("../lib/prisma");
const { asyncHandler, requireAuth, requireCreator } = require("../middleware/auth");
const { HttpError } = require("../middleware/errorHandler");
const bcrypt = require("bcryptjs");
const livekit = require("../lib/livekit");
const dropaphi = require("../lib/dropaphi");
const { checkInCredentialsTemplate } = require("../utils/email-templates");
const multer = require("multer");

const router = express.Router();
const creatorOnly = [requireAuth, requireCreator];
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function monthlySeries(records) {
  const now = new Date();
  const buckets = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (5 - index), 1);
    return { key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`, label: date.toLocaleString("en-US", { month: "short" }) };
  });
  const totals = new Map();
  records.forEach((record) => {
    const date = new Date(record.purchasedAt);
    if (Number.isNaN(date.getTime())) return;
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    totals.set(key, (totals.get(key) || 0) + Number(record.revenue || 0));
  });
  return { labels: buckets.map((bucket) => bucket.label), values: buckets.map((bucket) => totals.get(bucket.key) || 0) };
}

router.get(
  "/dashboard",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const [creator, videos, events, videoPurchases, ticketPurchases] = await Promise.all([
      prisma.creator.findUnique({ where: { id: req.creator.id }, select: { followersCount: true, videoPayoutPercent: true, eventStreamPayout: true, eventVenuePayout: true } }),
      prisma.creatorVideo.aggregate({ where: { creatorId: req.creator.id }, _sum: { revenue: true, viewsCount: true, likesCount: true, commentsCount: true }, _count: { _all: true } }),
      prisma.creatorEvent.aggregate({ where: { creatorId: req.creator.id }, _sum: { revenue: true, viewsCount: true, likesCount: true, commentsCount: true }, _count: { _all: true } }),
      prisma.creatorVideoPurchase.findMany({ where: { creatorId: req.creator.id, status: "COMPLETED" }, select: { purchasedAt: true, revenue: true } }),
      prisma.creatorEventTicketPurchase.findMany({ where: { status: "COMPLETED", ticket: { event: { creatorId: req.creator.id } } }, select: { purchasedAt: true, revenue: true, ticket: { select: { access: true } } } }),
    ]);
    const totalRevenue = (videos._sum.revenue || 0) + (events._sum.revenue || 0);
    const totalViews = (videos._sum.viewsCount || 0) + (events._sum.viewsCount || 0);
    const totalLikes = (videos._sum.likesCount || 0) + (events._sum.likesCount || 0);
    const totalComments = (videos._sum.commentsCount || 0) + (events._sum.commentsCount || 0);
    const stream = monthlySeries(ticketPurchases.filter((purchase) => purchase.ticket.access === "STREAM"));
    const venue = monthlySeries(ticketPurchases.filter((purchase) => purchase.ticket.access === "VENUE"));
    const video = monthlySeries(videoPurchases);
    res.json({
      stats: { totalRevenue, totalViews, totalFollowers: creator.followersCount, totalStreams: videos._count._all + events._count._all, totalLikes, totalComments, engagementRate: totalViews ? Math.round(((totalLikes + totalComments) / totalViews) * 100) : 0 },
      recentStreams: [],
      payoutSplit: { videoPayoutPercent: creator.videoPayoutPercent, eventStreamPayout: creator.eventStreamPayout, eventVenuePayout: creator.eventVenuePayout },
      revenueChart: { labels: video.labels, datasets: [{ label: "Video on demand", data: video.values }, { label: "Event tickets (stream)", data: stream.values }, { label: "Event tickets (venue)", data: venue.values }] },
    });
  })
);

router.get(
  "/monetization/summary",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const [videos, tickets, pending, settings] = await Promise.all([
      prisma.creatorVideoPurchase.findMany({ where: { creatorId: req.creator.id, status: "COMPLETED" }, select: { revenue: true } }),
      prisma.creatorEventTicketPurchase.findMany({ where: { status: "COMPLETED", ticket: { event: { creatorId: req.creator.id } } }, select: { revenue: true, ticket: { select: { access: true } } } }),
      prisma.creatorPayoutRequest.findMany({ where: { creatorId: req.creator.id, status: { in: ["pending", "processing"] } }, select: { amount: true } }),
      prisma.superAdminSetting.findFirst({ where: { section: "REVENUE" }, select: { minimumPayoutAmount: true } }),
    ]);
    const videoRevenue = videos.reduce((sum, row) => sum + Number(row.revenue || 0), 0);
    const streamRevenue = tickets.filter((row) => row.ticket.access === "STREAM").reduce((sum, row) => sum + Number(row.revenue || 0), 0);
    const venueRevenue = tickets.filter((row) => row.ticket.access === "VENUE").reduce((sum, row) => sum + Number(row.revenue || 0), 0);
    const pendingPayouts = pending.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const totalRevenue = videoRevenue + streamRevenue + venueRevenue;
    res.json({ summary: { totalRevenue, streamRevenue, venueRevenue, videoRevenue, availableForPayout: Math.max(totalRevenue - pendingPayouts, 0), pendingPayouts, minimumPayoutAmount: settings?.minimumPayoutAmount || 500 } });
  })
);

router.get(
  "/monetization/payouts",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const payoutRequests = await prisma.creatorPayoutRequest.findMany({ where: { creatorId: req.creator.id }, orderBy: { createdAt: "desc" }, select: { id: true, amount: true, status: true, note: true, receiptUrl: true, requestedAt: true, processedAt: true, payoutAccount: { select: { bankName: true, accountName: true, accountNumber: true, accountType: true } } } });
    res.json({ payoutRequests });
  })
);

router.post(
  "/monetization/payouts/send-otp",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const data = z.object({ accountId: z.string().min(1), amount: z.coerce.number().positive() }).parse(req.body);
    const account = await prisma.creatorPayoutAccount.findFirst({ where: { id: data.accountId, creatorId: req.creator.id, verified: true } });
    if (!account) throw new HttpError(404, "Selected payout account is invalid");
    await dropaphi.sendOtp(req.user.email, { brandName: process.env.DROPAPHI_FROM_NAME || "Xonnect", expiry: 10, length: 6 });
    res.json({ message: "OTP sent" });
  })
);

router.post(
  "/monetization/payouts/verify",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const data = z.object({ accountId: z.string().min(1), amount: z.coerce.number().positive(), code: z.string().min(1) }).parse(req.body);
    if (!await dropaphi.verifyOtp(req.user.email, data.code)) throw new HttpError(401, "Invalid OTP");
    const account = await prisma.creatorPayoutAccount.findFirst({ where: { id: data.accountId, creatorId: req.creator.id, verified: true } });
    if (!account) throw new HttpError(404, "Selected payout account is invalid");
    const request = await prisma.creatorPayoutRequest.create({ data: { id: dropid("payout_request"), creatorId: req.creator.id, payoutAccountId: account.id, amount: Math.round(data.amount), currency: "NGN", status: "pending" } });
    res.status(201).json({ payoutRequest: request, message: "Payout request created" });
  })
);

router.get(
  "/settings/profile",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const profile = await prisma.profile.findUnique({ where: { id: req.user.id } });
    if (!profile) throw new HttpError(404, "Creator profile not found");
    res.json({ profile: { email: profile.email, fullName: profile.fullName, creatorName: profile.creatorName, bio: profile.bio, website: profile.website, location: profile.location, avatarUrl: profile.avatarUrl, socialHandles: profile.socialHandles || [] } });
  })
);

router.put(
  "/settings/profile",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    if (req.body.email && req.body.email.toLowerCase().trim() !== req.user.email.toLowerCase()) throw new HttpError(400, "Email cannot be changed here");
    const data = z.object({ fullName: z.string().optional(), creatorName: z.string().optional(), bio: z.string().optional(), website: z.string().optional(), location: z.string().optional(), avatarUrl: z.string().optional(), socialHandles: z.array(z.object({ network: z.string(), handle: z.string() })).optional() }).parse(req.body);
    const profile = await prisma.profile.update({ where: { id: req.user.id }, data });
    res.json({ profile });
  })
);

router.get(
  "/settings/privacy",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const privacy = await prisma.profile.findUnique({ where: { id: req.user.id }, select: { profileVisibility: true, showEmail: true, showLocation: true, allowMessages: true, showOnlineStatus: true } });
    if (!privacy) throw new HttpError(404, "Profile not found");
    res.json({ privacy });
  })
);

router.put(
  "/settings/privacy",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const data = z.object({ profileVisibility: z.string().optional(), showEmail: z.boolean().optional(), showLocation: z.boolean().optional(), allowMessages: z.boolean().optional(), showOnlineStatus: z.boolean().optional() }).parse(req.body);
    const privacy = await prisma.profile.update({ where: { id: req.user.id }, data });
    res.json({ privacy });
  })
);

router.put(
  "/settings/password",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const data = z.object({ currentPassword: z.string().optional(), password: z.string().min(8) }).parse(req.body);
    const profile = await prisma.profile.findUnique({ where: { id: req.user.id }, include: { credential: true } });
    if (!profile) throw new HttpError(404, "User not found");
    if (profile.credential && (!data.currentPassword || !await bcrypt.compare(data.currentPassword, profile.credential.passwordHash))) throw new HttpError(401, profile.credential ? "Current password is incorrect" : "Current password is required");
    const passwordHash = await bcrypt.hash(data.password, 10);
    await prisma.$transaction([prisma.authCredential.upsert({ where: { email: profile.email }, update: { passwordHash }, create: { email: profile.email, passwordHash } }), prisma.profile.update({ where: { id: profile.id }, data: { hasPassword: true } })]);
    res.json({ message: "Password updated successfully" });
  })
);

router.post(
  "/settings/avatar",
  ...creatorOnly,
  avatarUpload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, "No file uploaded. Please provide a file in the 'file' field.");
    if (!req.file.mimetype.startsWith("image/")) throw new HttpError(400, "File must be an image");
    const result = await dropaphi.uploadFile({ name: req.file.originalname, type: req.file.mimetype, base64Data: req.file.buffer.toString("base64"), visibility: "PUBLIC" });
    const url = result.url || result.data?.url;
    if (!url) throw new HttpError(502, "Upload succeeded but no avatar URL was returned");
    const profile = await prisma.profile.update({ where: { id: req.user.id }, data: { avatarUrl: url } });
    res.json({ success: true, url, profile });
  })
);

const eventSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  category: z.string().trim().optional().default("music"),
  status: z.string().optional(),
  isPrivate: z.boolean().optional(),
  isPaid: z.boolean().optional(),
  requireTicket: z.boolean().optional(),
  enableDonations: z.boolean().optional(),
  enableLocationRestriction: z.boolean().optional(),
  locationRestrictionType: z.string().optional(),
  address: z.string().nullable().optional(),
  locationName: z.string().nullable().optional(),
  locationCountry: z.string().nullable().optional(),
  locationState: z.string().nullable().optional(),
  locationType: z.string().nullable().optional(),
  locationLat: z.number().nullable().optional(),
  locationLon: z.number().nullable().optional(),
  locationFullAddress: z.string().nullable().optional(),
  thumbnailUrl: z.string().nullable().optional(),
  thumbnailVideoUrl: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  scheduledAt: z.coerce.date().nullable().optional(),
  durationMinutes: z.number().int().positive().optional(),
  maxViewers: z.number().int().positive().nullable().optional(),
  estimatedUsers: z.number().int().nullable().optional(),
  tags: z.array(z.string()).optional(),
  restrictedLocations: z.array(z.object({
    name: z.string(),
    country: z.string(),
    state: z.string().nullable().optional(),
    lat: z.number().nullable().optional(),
    lon: z.number().nullable().optional(),
    type: z.string().optional(),
    fullAddress: z.string().nullable().optional(),
  })).optional(),
});

function enumValue(value, fallback) {
  const normalized = String(value || fallback).toUpperCase();
  return normalized === "PAUSED" ? "PAUSED" : normalized;
}

function eventData(data, existing) {
  const status = enumValue(data.status, existing?.status || "SCHEDULED");
  const allowedStatuses = ["DRAFT", "SCHEDULED", "LIVE", "PAUSED", "ENDED", "CANCELLED"];
  if (!allowedStatuses.includes(status)) throw new HttpError(400, "Invalid event status");

  return {
    title: data.title ?? existing.title,
    description: data.description ?? existing?.description ?? null,
    category: data.category || existing?.category || "music",
    status,
    isPrivate: data.isPrivate ?? existing?.isPrivate ?? false,
    isPaid: data.isPaid ?? existing?.isPaid ?? false,
    requireTicket: data.requireTicket ?? existing?.requireTicket ?? false,
    enableDonations: data.enableDonations ?? existing?.enableDonations ?? false,
    enableLocationRestriction: data.enableLocationRestriction ?? existing?.enableLocationRestriction ?? false,
    locationRestrictionType: String(data.locationRestrictionType || existing?.locationRestrictionType || "BLOCK").toUpperCase() === "ALLOW" ? "ALLOW" : "BLOCK",
    address: data.address ?? null,
    locationName: data.locationName ?? null,
    locationCountry: data.locationCountry ?? null,
    locationState: data.locationState ?? null,
    locationType: data.locationType ? String(data.locationType).toUpperCase() : existing?.locationType ?? null,
    locationLat: data.locationLat ?? existing?.locationLat ?? null,
    locationLon: data.locationLon ?? existing?.locationLon ?? null,
    locationFullAddress: data.locationFullAddress ?? existing?.locationFullAddress ?? null,
    thumbnailUrl: data.thumbnailUrl ?? existing?.thumbnailUrl ?? null,
    thumbnailVideoUrl: data.thumbnailVideoUrl ?? existing?.thumbnailVideoUrl ?? null,
    timezone: data.timezone || existing?.timezone || "Africa/Lagos",
    scheduledAt: data.scheduledAt ?? existing?.scheduledAt ?? null,
    durationMinutes: data.durationMinutes ?? existing?.durationMinutes ?? 60,
    maxViewers: data.maxViewers ?? existing?.maxViewers ?? null,
    estimatedUsers: data.estimatedUsers ?? existing?.estimatedUsers ?? null,
    tags: data.tags || existing?.tags || [],
  };
}

function locationCreates(locations) {
  if (!locations?.length) return undefined;
  return {
    create: locations.map((location) => ({
      name: location.name.trim(),
      country: location.country.trim(),
      state: location.state?.trim() || null,
      lat: location.lat ?? null,
      lon: location.lon ?? null,
      locationType: String(location.type || "CITY").toUpperCase(),
      fullAddress: location.fullAddress?.trim() || null,
    })),
  };
}

router.get(
  "/events",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const status = req.query.status;
    const search = String(req.query.search || "").trim();
    const where = {
      creatorId: req.creator.id,
      ...(req.query.ticketed === "true" ? { requireTicket: true } : {}),
      ...(status && status !== "all" ? { status: String(status).toUpperCase() } : {}),
      ...(search ? { OR: [{ title: { contains: search, mode: "insensitive" } }, { description: { contains: search, mode: "insensitive" } }] } : {}),
    };
    const events = await prisma.creatorEvent.findMany({
      where,
      orderBy: [{ scheduledAt: "desc" }, { createdAt: "desc" }],
      include: { restrictedLocations: true, _count: { select: { tickets: true, checkInUsers: true } } },
    });
    res.json({ events });
  })
);

router.post(
  "/events",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const data = eventSchema.partial().parse(req.body);
    const event = await prisma.creatorEvent.create({
      data: {
        id: dropid("event"),
        creatorId: req.creator.id,
        ...eventData(data),
        restrictedLocations: locationCreates(data.restrictedLocations),
      },
      include: { restrictedLocations: true },
    });
    res.status(201).json({ event, livekitProvisioning: "pending" });
  })
);

router.get(
  "/events/:id",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const event = await prisma.creatorEvent.findFirst({
      where: { id: req.params.id, creatorId: req.creator.id },
      include: { restrictedLocations: true, tickets: true, checkInUsers: true, checkInScans: true },
    });
    if (!event) throw new HttpError(404, "Event not found");
    res.json({ event });
  })
);

router.put(
  "/events/:id",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const existing = await prisma.creatorEvent.findFirst({ where: { id: req.params.id, creatorId: req.creator.id } });
    if (!existing) throw new HttpError(404, "Event not found");
    if (["LIVE", "ENDED"].includes(existing.status)) throw new HttpError(409, "Live or ended events cannot be edited");
    const data = eventSchema.parse(req.body);
    const event = await prisma.creatorEvent.update({ where: { id: existing.id }, data: eventData(data, existing) });
    res.json({ event });
  })
);

router.delete(
  "/events/:id",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const existing = await prisma.creatorEvent.findFirst({ where: { id: req.params.id, creatorId: req.creator.id } });
    if (!existing) throw new HttpError(404, "Event not found");
    await prisma.creatorEvent.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  })
);

router.get(
  "/events/:id/checkin-users",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const event = await prisma.creatorEvent.findFirst({ where: { id: req.params.id, creatorId: req.creator.id }, select: { id: true } });
    if (!event) throw new HttpError(404, "Event not found");
    const users = await prisma.creatorEventCheckInUser.findMany({ where: { eventId: event.id }, orderBy: { createdAt: "asc" } });
    res.json({ users });
  })
);

router.post(
  "/events/:id/checkin-users",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const event = await prisma.creatorEvent.findFirst({ where: { id: req.params.id, creatorId: req.creator.id }, select: { id: true, title: true } });
    if (!event) throw new HttpError(404, "Event not found");
    const data = z.object({ name: z.string().trim().min(1), email: z.string().email(), gate: z.string().trim().min(1), status: z.string().optional() }).parse(req.body);
    const temporaryPassword = Math.random().toString(36).slice(-8);
    const passwordHash = await bcrypt.hash(temporaryPassword, 10);
    const username = `${data.name.toLowerCase().replace(/\s+/g, "_")}_${Math.floor(Math.random() * 1000)}`;
    const user = await prisma.creatorEventCheckInUser.create({
      data: {
        id: dropid("checkin_user"),
        creatorId: req.creator.id,
        eventId: event.id,
        fullName: data.name,
        email: data.email.toLowerCase(),
        username,
        passwordHash,
        tempPasswordHash: passwordHash,
        gateName: data.gate,
        status: String(data.status || "ACTIVE").toUpperCase() === "INACTIVE" ? "INACTIVE" : "ACTIVE",
        mustChangePassword: true,
      },
    });
    let emailSent = true;
    try {
      await dropaphi.sendEmail({
        to: data.email.toLowerCase(),
        subject: "Your Xonnect gate check-in access",
        html: checkInCredentialsTemplate({
          fullName: data.name,
          eventTitle: event.title,
          gateName: data.gate,
          username,
          temporaryPassword,
        }),
        text: `Username: ${username}\nTemporary password: ${temporaryPassword}\nEvent: ${event.title}\nGate: ${data.gate}`,
        fromName: process.env.DROPAPHI_FROM_NAME || "Xonnect",
      });
    } catch (error) {
      emailSent = false;
      console.error("Check-in credential email failed:", error.message);
    }

    res.status(201).json({
      message: "Check-in user created",
      user,
      credentials: { username, password: temporaryPassword },
      emailSent,
    });
  })
);

router.patch(
  "/checkin-users/:id/status",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const status = String(req.body.status || "").toUpperCase();
    if (!["ACTIVE", "INACTIVE"].includes(status)) throw new HttpError(400, "Status must be ACTIVE or INACTIVE");
    const user = await prisma.creatorEventCheckInUser.findFirst({ where: { id: req.params.id, creatorId: req.creator.id } });
    if (!user) throw new HttpError(404, "Check-in user not found");
    const updated = await prisma.creatorEventCheckInUser.update({ where: { id: user.id }, data: { status } });
    res.json({ user: updated });
  })
);

router.get(
  "/events/:id/analytics",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const event = await prisma.creatorEvent.findFirst({
      where: { id: req.params.id, creatorId: req.creator.id },
      include: {
        tickets: { include: { purchases: { select: { id: true, amount: true, revenue: true, status: true, purchasedAt: true } } } },
        checkInUsers: { select: { id: true, fullName: true, email: true, gateName: true, status: true, scansToday: true, totalScans: true, lastLoginAt: true } },
        checkInScans: { orderBy: { scannedAt: "desc" }, take: 50, select: { id: true, attendeeName: true, attendeeEmail: true, gateName: true, status: true, scannedAt: true } },
      },
    });
    if (!event) throw new HttpError(404, "Event not found");
    const ticketSales = event.tickets.map((ticket) => {
      const completed = ticket.purchases.filter((purchase) => purchase.status === "COMPLETED");
      const refunded = ticket.purchases.filter((purchase) => purchase.status === "REFUNDED");
      return { id: ticket.id, ticketType: ticket.ticketType, access: ticket.access, status: ticket.status, price: ticket.revenue, quantity: ticket.quantity, soldCount: ticket.soldCount, revenue: completed.reduce((sum, purchase) => sum + purchase.amount, 0), completedSales: completed.length, refundedSales: refunded.length, availableSlots: Math.max(ticket.quantity - ticket.soldCount, 0) };
    });
    const totals = { users: event.checkInUsers.length, activeUsers: event.checkInUsers.filter((user) => user.status === "ACTIVE").length, inactiveUsers: event.checkInUsers.filter((user) => user.status === "INACTIVE").length, scans: event.checkInScans.length, successfulScans: event.checkInScans.filter((scan) => scan.status === "SUCCESS").length, duplicateScans: event.checkInScans.filter((scan) => scan.status === "DUPLICATE").length, invalidScans: event.checkInScans.filter((scan) => scan.status === "INVALID").length };
    res.json({ analytics: { event: { id: event.id, title: event.title, status: event.status, category: event.category, scheduledAt: event.scheduledAt, timezone: event.timezone, durationMinutes: event.durationMinutes, livekitRoomName: event.livekitRoomName, rtmpUrl: event.rtmpUrl, ingressId: event.ingressId, streamKey: event.streamKey, recordingEnabled: event.recordingEnabled, recordingStatus: event.recordingStatus, recordingUrl: event.recordedVideoUrl, hasRecordedVideo: event.hasRecordedVideo, recordingStartedAt: event.recordingStartedAt, recordingEndedAt: event.recordingEndedAt, revenue: event.revenue, viewsCount: event.viewsCount, likesCount: event.likesCount, commentsCount: event.commentsCount, peakViewersCount: event.peakViewersCount, currentViewersCount: event.currentViewersCount, venueParticipantCount: event.venueParticipantCount }, summary: { totalTicketRevenue: ticketSales.reduce((sum, ticket) => sum + ticket.revenue, 0), totalSales: ticketSales.reduce((sum, ticket) => sum + ticket.soldCount, 0), totalRefunds: ticketSales.reduce((sum, ticket) => sum + ticket.refundedSales, 0), checkInUsers: totals.users, successfulScans: totals.successfulScans, duplicateScans: totals.duplicateScans, invalidScans: totals.invalidScans }, ticketSales, checkInUsers: event.checkInUsers, recentScans: event.checkInScans, totals } });
  })
);

router.post(
  "/events/:id/livekit",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const event = await prisma.creatorEvent.findFirst({ where: { id: req.params.id, creatorId: req.creator.id }, select: { id: true, title: true, ingressId: true, streamKey: true, rtmpUrl: true, livekitRoomName: true } });
    if (!event) throw new HttpError(404, "Event not found");
    if (event.ingressId && event.streamKey && event.rtmpUrl && event.livekitRoomName) return res.json({ message: "LiveKit ingress already exists for this event", event, roomName: event.livekitRoomName });
    const roomName = `xonnect-event-${event.id}`;
    const created = await livekit.createEventIngress({ roomName, eventTitle: event.title });
    const updated = await prisma.creatorEvent.update({ where: { id: event.id }, data: { ingressId: created.ingressId, streamKey: created.streamKey, rtmpUrl: created.rtmpUrl, livekitRoomName: created.roomName } });
    res.status(201).json({ message: "LiveKit ingress generated", event: updated, livekit: { ingressId: created.ingressId, streamKey: created.streamKey, rtmpUrl: created.rtmpUrl, roomName: created.roomName, wsUrl: process.env.LIVEKIT_HOST ? process.env.LIVEKIT_HOST.replace(/^https:/, "wss:").replace(/^http:/, "ws:") : null } });
  })
);

router.delete(
  "/events/:id/recording",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const event = await prisma.creatorEvent.findFirst({ where: { id: req.params.id, creatorId: req.creator.id }, select: { id: true } });
    if (!event) throw new HttpError(404, "Event not found");
    const updated = await prisma.creatorEvent.update({ where: { id: event.id }, data: { recordedVideoUrl: null, recordedVideoFileId: null, recordingAssetId: null, hasRecordedVideo: false, recordingStatus: "DISABLED" } });
    res.json({ event: updated });
  })
);

const ticketSchema = z.object({
  ticketType: z.string().trim().min(1),
  access: z.string().optional(),
  price: z.coerce.number().min(0),
  quantity: z.coerce.number().int().min(0).optional().default(0),
  description: z.string().nullable().optional(),
  benefits: z.array(z.string()).optional().default([]),
});

router.get(
  "/events/:id/tickets",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const event = await prisma.creatorEvent.findFirst({ where: { id: req.params.id, creatorId: req.creator.id }, select: { id: true } });
    if (!event) throw new HttpError(404, "Event not found");
    const tickets = await prisma.creatorEventTicket.findMany({ where: { eventId: event.id }, orderBy: { createdAt: "asc" } });
    res.json({ tickets });
  })
);

router.post(
  "/events/:id/tickets",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const event = await prisma.creatorEvent.findFirst({ where: { id: req.params.id, creatorId: req.creator.id }, select: { id: true } });
    if (!event) throw new HttpError(404, "Event not found");
    const data = ticketSchema.parse(req.body);
    const ticket = await prisma.creatorEventTicket.create({
      data: { id: dropid("ticket"), eventId: event.id, ...data, access: String(data.access || "STREAM").toUpperCase() === "VENUE" ? "VENUE" : "STREAM" },
    });
    res.status(201).json({ message: "Ticket created", ticket });
  })
);

router.get(
  "/tickets/:id",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const ticket = await prisma.creatorEventTicket.findFirst({
      where: { id: req.params.id, event: { creatorId: req.creator.id } },
      include: { event: true, purchases: { orderBy: { purchasedAt: "desc" } } },
    });
    if (!ticket) throw new HttpError(404, "Ticket not found");
    res.json({ ticket });
  })
);

router.put(
  "/tickets/:id",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const ticket = await prisma.creatorEventTicket.findFirst({
      where: { id: req.params.id, event: { creatorId: req.creator.id } },
      include: { event: true },
    });
    if (!ticket) throw new HttpError(404, "Ticket not found");
    if (["LIVE", "ENDED"].includes(ticket.event.status)) throw new HttpError(409, "Live or ended events cannot be edited");
    const data = ticketSchema.partial().parse(req.body);
    const quantity = data.quantity ?? ticket.quantity;
    if (quantity < ticket.soldCount) throw new HttpError(400, "Quantity cannot be lower than tickets already sold");
    const updated = await prisma.creatorEventTicket.update({
      where: { id: ticket.id },
      data: {
        ...data,
        access: data.access ? (String(data.access).toUpperCase() === "VENUE" ? "VENUE" : "STREAM") : undefined,
        quantity,
      },
    });
    res.json({ ticket: updated });
  })
);

router.delete(
  "/tickets/:id",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const ticket = await prisma.creatorEventTicket.findFirst({
      where: { id: req.params.id, event: { creatorId: req.creator.id } },
      include: { event: true },
    });
    if (!ticket) throw new HttpError(404, "Ticket not found");
    if (ticket.event.status === "LIVE") throw new HttpError(409, "Live tickets cannot be deleted");
    await prisma.creatorEventTicket.delete({ where: { id: ticket.id } });
    res.json({ message: "Ticket deleted" });
  })
);

router.get(
  "/tickets/:id/sales",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const ticket = await prisma.creatorEventTicket.findFirst({
      where: { id: req.params.id, event: { creatorId: req.creator.id } },
      include: { event: true, purchases: { orderBy: { purchasedAt: "desc" } } },
    });
    if (!ticket) throw new HttpError(404, "Ticket not found");
    const search = String(req.query.search || "").toLowerCase();
    const status = String(req.query.status || "all").toLowerCase();
    const sales = ticket.purchases.filter((purchase) => {
      const searchable = `${purchase.buyerName || ""} ${purchase.buyerEmail || ""} ${purchase.transactionId || ""}`.toLowerCase();
      return (!search || searchable.includes(search)) && (status === "all" || String(purchase.status).toLowerCase() === status);
    });
    res.json({ ticket, sales });
  })
);

router.get(
  "/videos/folders",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const folders = await prisma.creatorVideoFolder.findMany({ where: { creatorId: req.creator.id }, orderBy: { createdAt: "desc" } });
    res.json({ folders });
  })
);

router.post(
  "/videos/folders",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const data = z.object({ title: z.string().trim().min(1), folderType: z.string().default("general") }).parse(req.body);
    const folder = await prisma.creatorVideoFolder.create({ data: { id: dropid("folder"), creatorId: req.creator.id, ...data } });
    res.status(201).json({ folder });
  })
);

router.get(
  "/videos/list",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const folders = await prisma.creatorVideoFolder.findMany({
      where: { creatorId: req.creator.id },
      orderBy: { createdAt: "desc" },
      include: { videos: { orderBy: { episodeIndex: "asc" } } },
    });
    const items = folders.map((folder) => ({
      id: folder.id,
      title: folder.title,
      contentType: folder.folderType,
      status: folder.status,
      thumbnail: folder.thumbnailUrl,
      uploadDate: folder.createdAt,
      itemsCount: folder.videos.length,
      videos: folder.videos.map((video) => ({
        id: video.id,
        title: video.title,
        duration: video.duration,
        status: video.status,
        thumbnail: video.thumbnailUrl,
        uploadDate: video.createdAt,
        views: video.viewsCount,
        likes: video.likesCount,
        comments: video.commentsCount,
        revenue: video.revenue,
      })),
    }));
    res.json({ items });
  })
);

router.get(
  "/videos/:id",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const folder = await prisma.creatorVideoFolder.findFirst({
      where: { id: req.params.id, creatorId: req.creator.id },
      include: { videos: { orderBy: { episodeIndex: "asc" } } },
    });
    if (!folder) throw new HttpError(404, "Folder not found");
    res.json({
      folder: {
        id: folder.id,
        title: folder.title,
        contentType: folder.folderType,
        status: folder.status,
        thumbnail: folder.thumbnailUrl,
        uploadDate: folder.createdAt,
        description: null,
        parts: folder.videos,
      },
    });
  })
);

router.put(
  "/videos/:id/edit",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const video = await prisma.creatorVideo.findFirst({
      where: { id: req.params.id, creatorId: req.creator.id },
      include: { folder: true },
    });
    if (!video) throw new HttpError(404, "Video not found");
    const data = z.object({
      title: z.string().trim().min(1),
      description: z.string().nullable().optional(),
      category: z.string().nullable().optional(),
      videoUrl: z.string().nullable().optional(),
      videoFileId: z.string().nullable().optional(),
      thumbnailUrl: z.string().nullable().optional(),
      thumbnailFileId: z.string().nullable().optional(),
      duration: z.string().nullable().optional(),
      isPrivate: z.boolean().optional(),
      isPremium: z.boolean().optional(),
      monetizationType: z.string().optional(),
      rent24Price: z.coerce.number().int().min(0).nullable().optional(),
      rent48Price: z.coerce.number().int().min(0).nullable().optional(),
      purchasePrice: z.coerce.number().int().min(0).nullable().optional(),
      allowComments: z.boolean().optional(),
      ageRestriction: z.boolean().optional(),
      status: z.string().optional(),
      publishNow: z.boolean().optional(),
      scheduledAt: z.coerce.date().nullable().optional(),
      tags: z.array(z.string()).optional(),
      packageName: z.string().nullable().optional(),
      episodeIndex: z.number().int().nullable().optional(),
      contentType: z.string().optional(),
    }).parse(req.body);
    const { contentType, packageName, ...videoData } = data;
    const updated = await prisma.$transaction(async (tx) => {
      if (packageName || contentType) {
        await tx.creatorVideoFolder.update({ where: { id: video.folderId }, data: { ...(packageName ? { title: packageName } : {}), ...(contentType ? { folderType: contentType } : {}) } });
      }
      return tx.creatorVideo.update({ where: { id: video.id }, data: videoData });
    });
    res.json({ video: updated });
  })
);

router.post(
  "/videos",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const data = z.object({
      folderId: z.string().min(1),
      title: z.string().trim().min(1),
      description: z.string().nullable().optional(),
      category: z.string().nullable().optional(),
      videoUrl: z.string().nullable().optional(),
      videoFileId: z.string().nullable().optional(),
      thumbnailUrl: z.string().nullable().optional(),
      thumbnailFileId: z.string().nullable().optional(),
      duration: z.string().nullable().optional(),
      isPrivate: z.boolean().optional(),
      isPremium: z.boolean().optional(),
      monetizationType: z.string().optional(),
      rent24Price: z.coerce.number().int().min(0).nullable().optional(),
      rent48Price: z.coerce.number().int().min(0).nullable().optional(),
      purchasePrice: z.coerce.number().int().min(0).nullable().optional(),
      allowComments: z.boolean().optional(),
      ageRestriction: z.boolean().optional(),
      status: z.string().optional(),
      publishNow: z.boolean().optional(),
      scheduledAt: z.coerce.date().nullable().optional(),
      tags: z.array(z.string()).optional(),
      packageName: z.string().nullable().optional(),
      episodeIndex: z.number().int().nullable().optional(),
    }).parse(req.body);
    const folder = await prisma.creatorVideoFolder.findFirst({ where: { id: data.folderId, creatorId: req.creator.id } });
    if (!folder) throw new HttpError(404, "Folder not found");
    const video = await prisma.creatorVideo.create({
      data: {
        id: dropid("video"),
        creatorId: req.creator.id,
        ...data,
        status: data.status || (data.publishNow === false ? "scheduled" : "published"),
        publishNow: data.publishNow ?? true,
      },
    });
    res.status(201).json({ video });
  })
);

router.get(
  "/videos/:id/analytics",
  ...creatorOnly,
  asyncHandler(async (req, res) => {
    const folder = await prisma.creatorVideoFolder.findFirst({ where: { id: req.params.id, creatorId: req.creator.id }, include: { videos: true } });
    if (!folder) throw new HttpError(404, "Folder not found");
    const range = String(req.query.range || "7d");
    const days = range === "30d" ? 30 : range === "90d" || range === "all" ? 90 : 7;
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - days + 1);
    const videoIds = folder.videos.map((video) => video.id);
    const [views, likes, comments, purchases, recentComments] = await Promise.all([
      prisma.creatorVideoView.findMany({ where: { creatorVideoId: { in: videoIds }, createdAt: { gte: start } }, select: { createdAt: true } }),
      prisma.creatorVideoLike.findMany({ where: { creatorVideoId: { in: videoIds }, createdAt: { gte: start } }, select: { createdAt: true } }),
      prisma.creatorVideoComment.findMany({ where: { creatorVideoId: { in: videoIds }, createdAt: { gte: start } }, select: { createdAt: true } }),
      prisma.creatorVideoPurchase.findMany({ where: { creatorVideoId: { in: videoIds }, status: "COMPLETED", purchasedAt: { gte: start } }, select: { purchasedAt: true, purchaseType: true } }),
      prisma.creatorVideoComment.findMany({ where: { creatorVideoId: { in: videoIds } }, orderBy: { createdAt: "desc" }, take: 10, include: { commenterProfile: { select: { fullName: true, avatarUrl: true } } } }),
    ]);
    const key = (date) => new Date(date).toISOString().slice(0, 10);
    const series = Array.from({ length: days }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); return { date: date.toISOString().slice(0, 10), views: 0, likes: 0, comments: 0, shares: 0, watchTime: 0, purchases: 0, rentals24h: 0, rentals48h: 0 }; });
    const byDate = new Map(series.map((item) => [item.date, item]));
    views.forEach((item) => { const row = byDate.get(key(item.createdAt)); if (row) row.views++; });
    likes.forEach((item) => { const row = byDate.get(key(item.createdAt)); if (row) row.likes++; });
    comments.forEach((item) => { const row = byDate.get(key(item.createdAt)); if (row) row.comments++; });
    purchases.forEach((item) => { const row = byDate.get(key(item.purchasedAt)); if (row) { row.purchases++; if (item.purchaseType === "rent24") row.rentals24h++; if (item.purchaseType === "rent48") row.rentals48h++; } });
    const totalViews = folder.videos.reduce((sum, video) => sum + video.viewsCount, 0);
    const totalLikes = folder.videos.reduce((sum, video) => sum + video.likesCount, 0);
    const totalComments = folder.videos.reduce((sum, video) => sum + video.commentsCount, 0);
    const totalRevenue = folder.videos.reduce((sum, video) => sum + video.revenue, 0);
    const purchaseCount = purchases.length;
    res.json({ folder: { id: folder.id, title: folder.title, contentType: folder.folderType, status: folder.status, thumbnail: folder.thumbnailUrl, uploadDate: folder.createdAt, views: totalViews, likes: totalLikes, comments: totalComments, revenue: totalRevenue, shares: 0, watchTimeSeconds: 0, purchases: purchaseCount, rentals24h: purchases.filter((item) => item.purchaseType === "rent24").length, rentals48h: purchases.filter((item) => item.purchaseType === "rent48").length, isPremium: folder.videos.some((video) => video.isPremium), duration: folder.videos[0]?.duration || null, description: null, tags: [...new Set(folder.videos.flatMap((video) => video.tags || []))] }, timeSeries: { range, items: series }, comments: recentComments.map((comment) => ({ id: comment.id, author: comment.commenterProfile?.fullName || "Anonymous", text: comment.content, date: comment.createdAt.toLocaleDateString(), likes: 0, replies: 0, avatar: comment.commenterProfile?.avatarUrl || null })), engagementBreakdown: { likes: totalLikes, comments: totalComments, shares: 0, purchases: purchaseCount, rentals24h: purchases.filter((item) => item.purchaseType === "rent24").length, rentals48h: purchases.filter((item) => item.purchaseType === "rent48").length }, episodesCount: videoIds.length });
  })
);

module.exports = router;
