const express = require("express");
const { z } = require("zod");
const { dropid } = require("dropid");
const prisma = require("../lib/prisma");
const dropaphi = require("../lib/dropaphi");
const { asyncHandler, requireAuth, requireAdmin } = require("../middleware/auth");
const { HttpError } = require("../middleware/errorHandler");

const router = express.Router();
const adminOnly = [requireAuth, requireAdmin];

router.get("/users", ...adminOnly, asyncHandler(async (req, res) => {
  const profiles = await prisma.profile.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { videoPurchases: true, creatorFollows: true, eventLikes: true } } },
  });
  const purchases = await prisma.creatorVideoPurchase.groupBy({ by: ["buyerProfileId"], where: { buyerProfileId: { not: null } }, _sum: { amount: true } });
  const spentByUser = new Map(purchases.map((purchase) => [purchase.buyerProfileId, purchase._sum.amount || 0]));
  res.json({ users: profiles.map((profile) => ({ id: profile.id, name: profile.fullName || profile.email, email: profile.email, status: profile.role === "USER" ? (profile.lastLogin ? "active" : "inactive") : String(profile.role).toLowerCase(), joinDate: profile.createdAt, lastActive: profile.lastLogin, purchases: profile._count.videoPurchases, totalSpent: spentByUser.get(profile.id) || 0, savedEvents: profile._count.eventLikes, followers: profile._count.creatorFollows, role: profile.role })) });
}));

function creatorShape(creator) {
  return { id: creator.id, profileId: creator.profileId, status: creator.status, videoPayoutPercent: creator.videoPayoutPercent, eventStreamPayout: creator.eventStreamPayout, eventVenuePayout: creator.eventVenuePayout, followersCount: creator.followersCount, followingCount: creator.followingCount, profile: creator.profile, createdAt: creator.createdAt, updatedAt: creator.updatedAt };
}

router.get("/dashboard", ...adminOnly, asyncHandler(async (req, res) => {
  const [creators, events, videos, payouts] = await Promise.all([
    prisma.creator.count(),
    prisma.creatorEvent.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { creator: { include: { profile: { select: { fullName: true } } } } } }),
    prisma.creatorVideo.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { creator: { include: { profile: { select: { fullName: true } } } } } }),
    prisma.creatorPayoutRequest.findMany({ orderBy: { requestedAt: "desc" }, take: 50, include: { creator: { include: { profile: { select: { fullName: true } } } } } }),
  ]);
  const totalRevenue = [...events, ...videos].reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const platformFee = [...events, ...videos].reduce((sum, row) => sum + Number(row.platformFee || 0), 0);
  res.json({ overview: { totalRevenue, platformFee, activeCreators: creators, totalViews: [...events, ...videos].reduce((sum, row) => sum + Number(row.viewsCount || 0), 0) }, revenueData: { totalRevenue, platformFee }, revenueTrend: [], topCreators: [], recent: payouts.map((payout) => ({ id: payout.id, type: "payout", title: payout.creator?.profile?.fullName || "Payout", createdAt: payout.requestedAt, amount: payout.amount })) });
}));

router.get("/creators", ...adminOnly, asyncHandler(async (req, res) => {
  const [creators, videoTotals, eventTotals] = await Promise.all([
    prisma.creator.findMany({ include: { profile: { select: { id: true, email: true, fullName: true, avatarUrl: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.creatorVideo.aggregate({ _sum: { revenue: true, platformFee: true } }),
    prisma.creatorEvent.aggregate({ _sum: { revenue: true, platformFee: true } }),
  ]);
  res.json({ creators: creators.map(creatorShape), stats: { totalCreators: creators.length, activeCreators: creators.filter((creator) => creator.status === "active").length, platformRevenue: (videoTotals._sum.platformFee || 0) + (eventTotals._sum.platformFee || 0), creatorRevenue: (videoTotals._sum.revenue || 0) + (eventTotals._sum.revenue || 0) } });
}));

router.get("/creators/:id", ...adminOnly, asyncHandler(async (req, res) => {
  const creator = await prisma.creator.findUnique({ where: { id: req.params.id }, include: { profile: { select: { id: true, email: true, fullName: true, avatarUrl: true } } } });
  if (!creator) throw new HttpError(404, "Creator not found");
  res.json({ creator: creatorShape(creator) });
}));

router.put("/creators/:id", ...adminOnly, asyncHandler(async (req, res) => {
  const data = z.object({ status: z.string().optional(), videoPayoutPercent: z.number().optional(), eventStreamPayout: z.number().optional(), eventVenuePayout: z.number().optional() }).parse(req.body);
  const creator = await prisma.creator.update({ where: { id: req.params.id }, data, include: { profile: { select: { id: true, email: true, fullName: true, avatarUrl: true } } } });
  res.json({ creator: creatorShape(creator) });
}));

router.post("/creators/send-email", ...adminOnly, asyncHandler(async (req, res) => {
  const data = z.object({ subject: z.string().trim().min(1), message: z.string().trim().min(1), creatorId: z.string().optional(), sendToAll: z.boolean().optional() }).parse(req.body);
  let creators;
  if (data.sendToAll) {
    creators = await prisma.creator.findMany({ include: { profile: { select: { email: true, fullName: true } } } });
  } else if (data.creatorId) {
    const creator = await prisma.creator.findUnique({ where: { id: data.creatorId }, include: { profile: { select: { email: true, fullName: true } } } });
    if (!creator) throw new HttpError(404, "Creator not found");
    creators = [creator];
  } else {
    throw new HttpError(400, "creatorId or sendToAll is required");
  }
  const recipients = creators.filter((creator) => creator.profile?.email);
  await Promise.allSettled(recipients.map((creator) => dropaphi.sendEmail({ to: creator.profile.email, subject: data.subject, text: data.message, html: `<p>${data.message.replace(/\n/g, "<br />")}</p>` })));
  res.json({ ok: true, message: `Email sent to ${recipients.length} creator${recipients.length === 1 ? "" : "s"}` });
}));

router.get("/payouts", ...adminOnly, asyncHandler(async (req, res) => {
  const requests = await prisma.creatorPayoutRequest.findMany({ orderBy: [{ status: "asc" }, { requestedAt: "desc" }], include: { creator: { include: { profile: { select: { email: true, fullName: true, avatarUrl: true } } } }, payoutAccount: true } });
  res.json({ payouts: requests.map((request) => ({ id: request.id, creatorId: request.creatorId, creatorName: request.creator?.profile?.fullName || "Unknown creator", creatorEmail: request.creator?.profile?.email || "", creatorAvatar: request.creator?.profile?.avatarUrl || "", amount: request.amount, status: request.status, note: request.note, receiptUrl: request.receiptUrl, transactionId: request.transactionId, requestDate: request.requestedAt, processedDate: request.processedAt, paymentMethod: "Bank Transfer", bankDetails: request.payoutAccount ? { bankName: request.payoutAccount.bankName, accountNumber: request.payoutAccount.accountNumber, accountName: request.payoutAccount.accountName, accountType: request.payoutAccount.accountType, isVerified: request.payoutAccount.verified } : undefined })) });
}));

router.patch("/payouts/:id", ...adminOnly, asyncHandler(async (req, res) => {
  const action = String(req.body.action || "");
  const payout = await prisma.creatorPayoutRequest.findUnique({ where: { id: req.params.id } });
  if (!payout) throw new HttpError(404, "Payout request not found");
  const status = { approve: "processing", complete: "completed", reject: "rejected" }[action];
  if (!status && action !== "upload-receipt") throw new HttpError(400, "Invalid action");
  if (action === "complete" && !req.body.receiptUrl) throw new HttpError(400, "Receipt is required before completing this payout");
  const updated = await prisma.creatorPayoutRequest.update({ where: { id: payout.id }, data: { ...(status ? { status } : {}), ...(req.body.note !== undefined ? { note: req.body.note } : {}), ...(req.body.receiptUrl ? { receiptUrl: req.body.receiptUrl } : {}), ...(status ? { processedAt: new Date() } : {}) } });
  res.json({ payoutRequest: updated, message: `Payout ${action === "approve" ? "approved" : action === "complete" ? "completed" : action === "reject" ? "rejected" : "updated"}` });
}));

router.post("/payouts/:id", ...adminOnly, asyncHandler(async (req, res) => {
  if (!req.body.receiptUrl) throw new HttpError(400, "Receipt URL is required");
  const payout = await prisma.creatorPayoutRequest.update({ where: { id: req.params.id }, data: { receiptUrl: req.body.receiptUrl, transactionId: req.body.transactionId || dropid("payout_receipt") } });
  res.json({ payoutRequest: payout, receiptUrl: payout.receiptUrl });
}));

router.get("/revenue", ...adminOnly, asyncHandler(async (req, res) => {
  const [events, videos] = await Promise.all([
    prisma.creatorEvent.findMany({ orderBy: { createdAt: "desc" }, include: { creator: { include: { profile: { select: { fullName: true } } } } } }),
    prisma.creatorVideo.findMany({ orderBy: { createdAt: "desc" }, include: { creator: { include: { profile: { select: { fullName: true } } } }, _count: { select: { purchases: true } } } }),
  ]);
  const eventRevenue = events.reduce((sum, event) => sum + Number(event.revenue || 0), 0);
  const videoRevenue = videos.reduce((sum, video) => sum + Number(video.revenue || 0), 0);
  res.json({ overview: { total: eventRevenue + videoRevenue, streams: eventRevenue, premiumVideos: videoRevenue, ads: 0, platformEarnings: events.reduce((s, e) => s + Number(e.platformFee || 0), 0) + videos.reduce((s, v) => s + Number(v.platformFee || 0), 0), payoutEarnings: eventRevenue + videoRevenue, growth: 0 }, events: events.map((event) => ({ id: event.id, creatorName: event.creator?.profile?.fullName || "Unknown Creator", streamTitle: event.title, revenue: event.revenue, platformEarnings: event.platformFee, payoutEarnings: event.revenue, viewers: event.viewsCount, duration: `${event.durationMinutes}m`, date: event.createdAt, type: event.isPaid ? "Premium" : "Standard" })), videos: videos.map((video) => ({ id: video.id, creatorName: video.creator?.profile?.fullName || "Unknown Creator", videoTitle: video.title, revenue: video.revenue, platformEarnings: video.platformFee, payoutEarnings: video.revenue, views: video.viewsCount, price: video.purchasePrice, sales: video._count.purchases, date: video.createdAt })) });
}));

router.get("/tickets", ...adminOnly, asyncHandler(async (req, res) => {
  const tickets = await prisma.creatorEventTicket.findMany({ orderBy: { createdAt: "desc" }, include: { event: { include: { creator: { include: { profile: { select: { fullName: true, email: true } } } } } }, purchases: true } });
  const records = tickets.map((ticket) => ({ id: ticket.id, creator: ticket.event.creator.profile.fullName || "Unknown Creator", creatorEmail: ticket.event.creator.profile.email, eventName: ticket.event.title, ticketType: ticket.ticketType, totalIssued: ticket.quantity, totalSold: ticket.soldCount, revenue: ticket.revenue + ticket.platformFee, creatorRevenue: ticket.revenue, platformRevenue: ticket.platformFee, access: ticket.access === "VENUE" ? "Venue" : "Stream", createdDate: ticket.createdAt, status: ticket.status === "ACTIVE" ? "active" : "inactive", platform: ticket.access === "VENUE" ? "physical" : "streaming", purchases: ticket.purchases.map((purchase) => ({ id: purchase.id, buyer: purchase.buyerName || purchase.buyerEmail, amount: purchase.amount, creatorRevenue: purchase.revenue, platformRevenue: purchase.platformFee, status: String(purchase.status).toLowerCase(), transactionId: purchase.transactionId, date: purchase.purchasedAt })) }));
  res.json({ records, stats: { totalRevenue: records.reduce((s, r) => s + r.revenue, 0), totalTicketsSold: records.reduce((s, r) => s + r.totalSold, 0), activeTickets: records.filter((r) => r.status === "active").length, streamTickets: records.filter((r) => r.access === "Stream").length, venueTickets: records.filter((r) => r.access === "Venue").length } });
}));

router.get("/enterprise-requests", ...adminOnly, asyncHandler(async (req, res) => { res.json({ requests: await prisma.enterpriseRequest.findMany({ orderBy: { createdAt: "desc" } }) }); }));
router.patch("/enterprise-requests/:id", ...adminOnly, asyncHandler(async (req, res) => { const status = req.body.action === "approve" ? "approved" : req.body.action === "reject" ? "rejected" : null; if (!status) throw new HttpError(400, "Invalid action"); const request = await prisma.enterpriseRequest.update({ where: { id: req.params.id }, data: { status } }); res.json({ ok: true, request }); }));
router.post("/enterprise-requests/send-email", ...adminOnly, asyncHandler(async (req, res) => { const request = await prisma.enterpriseRequest.findUnique({ where: { id: req.body.requestId } }); if (!request) throw new HttpError(404, "Request not found"); await dropaphi.sendEmail({ to: request.email, subject: req.body.subject, text: req.body.message, html: `<p>${String(req.body.message).replace(/\n/g, "<br />")}</p>` }); res.json({ ok: true }); }));

router.get("/settings", ...adminOnly, asyncHandler(async (req, res) => { const settings = await prisma.superAdminSetting.findMany(); const revenue = settings.find((s) => s.section === "REVENUE"); const company = settings.find((s) => s.section === "COMPANY_INFO"); res.json({ settings: { revenue: revenue ? { platformFeePercentage: revenue.platformFeePercentage, enterpriseFeePercentage: revenue.enterpriseFeePercentage, minimumPayoutAmount: revenue.minimumPayoutAmount, payoutProcessingDays: revenue.payoutProcessingDays } : null, company: company ? { companyName: company.companyName, companyEmail: company.companyEmail, supportEmail: company.supportEmail, companyPhone: company.companyPhone, companyAddress: company.companyAddress, companyWebsite: company.companyWebsite } : null } }); }));
router.post("/settings", ...adminOnly, asyncHandler(async (req, res) => { const section = req.body.section === "revenue" ? "REVENUE" : req.body.section === "company" ? "COMPANY_INFO" : null; if (!section) throw new HttpError(400, "section is required"); const existing = await prisma.superAdminSetting.findUnique({ where: { section } }); if (existing) throw new HttpError(409, "Settings already exist for this section. Use PUT to update."); const data = req.body.data || {}; const created = await prisma.superAdminSetting.create({ data: { id: dropid("setting"), section, ...(section === "REVENUE" ? { platformFeePercentage: data.platformFeePercentage, enterpriseFeePercentage: data.enterpriseFeePercentage, minimumPayoutAmount: data.minimumPayoutAmount, payoutProcessingDays: data.payoutProcessingDays } : { companyName: data.companyName, companyEmail: data.companyEmail, supportEmail: data.supportEmail, companyPhone: data.companyPhone, companyAddress: data.companyAddress, companyWebsite: data.companyWebsite }), createdBy: req.user.email, updatedBy: req.user.email } }); res.status(201).json({ settings: { [section === "REVENUE" ? "revenue" : "company"]: created } }); }));
router.put("/settings", ...adminOnly, asyncHandler(async (req, res) => { const section = req.body.section === "revenue" ? "REVENUE" : "COMPANY_INFO"; const data = req.body.data || {}; const updated = await prisma.superAdminSetting.update({ where: { section }, data: { ...data, updatedBy: req.user.email } }); res.json({ settings: { [section === "REVENUE" ? "revenue" : "company"]: updated } }); }));
router.delete("/settings", ...adminOnly, asyncHandler(async (req, res) => { const section = req.body.section === "revenue" ? "REVENUE" : "COMPANY_INFO"; await prisma.superAdminSetting.delete({ where: { section } }); res.json({ ok: true }); }));

router.get("/categories", ...adminOnly, asyncHandler(async (req, res) => { res.json({ categories: await prisma.category.findMany({ orderBy: { createdAt: "desc" } }) }); }));
router.put("/categories", ...adminOnly, asyncHandler(async (req, res) => { const data = z.object({ id: z.string().optional(), name: z.string().min(2), slug: z.string().optional(), description: z.string().nullable().optional(), isActive: z.boolean().optional() }).parse(req.body); const slug = data.slug || data.name.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-"); const category = data.id ? await prisma.category.update({ where: { id: data.id }, data: { ...data, slug } }) : await prisma.category.create({ data: { ...data, slug } }); res.status(data.id ? 200 : 201).json({ category }); }));
router.delete("/categories/:id", ...adminOnly, asyncHandler(async (req, res) => { await prisma.category.delete({ where: { id: req.params.id } }); res.json({ ok: true }); }));

module.exports = router;
