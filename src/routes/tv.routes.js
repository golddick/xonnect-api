const express = require("express");
const prisma = require("../lib/prisma");
const { asyncHandler } = require("../middleware/auth");

const router = express.Router();

const categories = [
  { id: "live-event", label: "Live Event", href: "/tv/live-event" },
  { id: "video", label: "Video", href: "/tv/video" },
  { id: "sport", label: "Sport", href: "/tv/sport" },
  { id: "podcast", label: "Podcast", href: "/tv/podcast" },
  { id: "tv-show", label: "TV Show", href: "/tv/tv-show" },
];

const creatorSelect = {
  profile: { select: { fullName: true, creatorName: true, avatarUrl: true } },
};

const eventSelect = {
  id: true,
  title: true,
  category: true,
  status: true,
  thumbnailUrl: true,
  thumbnailVideoUrl: true,
  scheduledAt: true,
  durationMinutes: true,
  currentViewersCount: true,
  peakViewersCount: true,
  creator: { select: creatorSelect },
};

const videoSelect = {
  id: true,
  title: true,
  category: true,
  status: true,
  thumbnailUrl: true,
  duration: true,
  viewsCount: true,
  scheduledAt: true,
  monetizationType: true,
  isPremium: true,
  folder: { select: { id: true, title: true, folderType: true } },
  creator: { select: creatorSelect },
};

function initials(name) {
  const parts = String(name || "TV").trim().split(/\s+/).filter(Boolean);
  return parts.length > 1
    ? `${parts[0][0]}${parts[1][0]}`.toUpperCase()
    : parts[0].slice(0, 2).toUpperCase();
}

function cardFromEvent(event) {
  const name = event.creator.profile.fullName || event.creator.profile.creatorName || "Xonnect Creator";
  return {
    id: event.id,
    watchId: event.id,
    title: event.title,
    thumbnail: event.thumbnailUrl || event.thumbnailVideoUrl || "/placeholder.svg?query=xonnect-tv",
    channelName: name,
    channelAvatar: initials(name),
    channelAvatarUrl: event.creator.profile.avatarUrl,
    viewers: event.currentViewersCount || event.peakViewersCount || 0,
    isLive: event.status === "LIVE",
    category: event.category,
    type: event.status === "LIVE" ? "live" : event.status === "SCHEDULED" ? "scheduled" : "ended",
    duration: `${event.durationMinutes}m`,
    scheduledAt: event.scheduledAt,
  };
}

function cardFromVideo(video) {
  const name = video.creator.profile.fullName || video.creator.profile.creatorName || "Xonnect Creator";
  return {
    id: video.id,
    watchId: video.folder?.id || video.id,
    title: video.title,
    thumbnail: video.thumbnailUrl || "/placeholder.svg?query=xonnect-video",
    channelName: name,
    channelAvatar: initials(name),
    channelAvatarUrl: video.creator.profile.avatarUrl,
    viewers: video.viewsCount || 0,
    isLive: false,
    category: video.category || video.folder?.folderType || "video",
    type: "video",
    duration: video.duration,
    pricing: video.isPremium ? video.monetizationType || "purchase" : "free",
    scheduledAt: video.scheduledAt,
  };
}

function orderCards(cards) {
  return cards.sort((left, right) => {
    if (left.isLive !== right.isLive) return left.isLive ? -1 : 1;
    return (right.viewers || 0) - (left.viewers || 0);
  });
}

async function publicEvents(where, take = 12) {
  const events = await prisma.creatorEvent.findMany({
    where: { isPrivate: false, ...where },
    orderBy: [{ currentViewersCount: "desc" }, { scheduledAt: "asc" }, { createdAt: "desc" }],
    take,
    select: eventSelect,
  });
  return events.map(cardFromEvent);
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const [live, scheduled, videos] = await Promise.all([
      publicEvents({ status: "LIVE" }, 6),
      publicEvents({ status: "SCHEDULED" }, 6),
      prisma.creatorVideo.findMany({
        where: { isPrivate: false, status: { in: ["published", "scheduled"] } },
        orderBy: { createdAt: "desc" },
        take: 12,
        select: videoSelect,
      }),
    ]);

    const liveCards = live;
    const videoCards = videos.map(cardFromVideo);
    const priorityFeed = orderCards([...liveCards, ...scheduled, ...videoCards]);
    res.json({
      featuredCarousel: priorityFeed.slice(0, 5),
      priorityFeed,
      contentColumns: { live: [...liveCards, ...scheduled], video: videoCards },
      sidebar: { categories, liveEvents: [...liveCards, ...scheduled].slice(0, 4) },
    });
  })
);

router.get(
  "/sport",
  asyncHandler(async (req, res) => {
    const [liveBroadcasts, scheduledBroadcasts, videos] = await Promise.all([
      publicEvents({ status: "LIVE", category: { equals: "sport", mode: "insensitive" } }),
      publicEvents({ status: "SCHEDULED", category: { equals: "sport", mode: "insensitive" } }),
      prisma.creatorVideo.findMany({
        where: {
          isPrivate: false,
          status: { in: ["published", "scheduled"] },
          OR: [
            { category: { equals: "sport", mode: "insensitive" } },
            { folder: { folderType: { equals: "sport", mode: "insensitive" } } },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: 12,
        select: videoSelect,
      }),
    ]);
    const videoFolders = videos.map(cardFromVideo);
    res.json({ sport: { liveBroadcasts, scheduledBroadcasts, videoFolders, all: [...liveBroadcasts, ...scheduledBroadcasts, ...videoFolders] }, sidebar: { categories, liveEvents: liveBroadcasts.slice(0, 4) } });
  })
);

router.get(
  "/movie",
  asyncHandler(async (req, res) => {
    const search = String(req.query.search || "").trim();
    const pricing = String(req.query.pricing || "all");
    const videos = await prisma.creatorVideo.findMany({
      where: {
        isPrivate: false,
        status: { in: ["published", "scheduled"] },
        ...(search ? { title: { contains: search, mode: "insensitive" } } : {}),
        ...(pricing === "free" ? { isPremium: false } : pricing === "rent" ? { monetizationType: { startsWith: "rent" } } : pricing === "purchase" ? { monetizationType: "purchase" } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: videoSelect,
    });
    res.json({ items: videos.map(cardFromVideo), total: videos.length, filters: { pricing, search }, source: "direct_videos" });
  })
);

module.exports = router;