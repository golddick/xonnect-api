const express = require("express");
const prisma = require("../lib/prisma");
const { asyncHandler, requireAuth, optionalAuth, requireCreator } = require("../middleware/auth");
const { HttpError } = require("../middleware/errorHandler");
const livekit = require("../lib/livekit");

const router = express.Router();

function wsUrl(httpsUrl) {
  return (httpsUrl || "").replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
}

// POST /api/events/:id/livestream/start — creator goes live; provisions a LiveKit room + RTMP ingress
router.post(
  "/:id/livestream/start",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const event = await prisma.creatorEvent.findUnique({ where: { id: req.params.id } });
    if (!event) throw new HttpError(404, "Event not found");
    if (event.creatorId !== req.creator.id) throw new HttpError(403, "You don't own this event");
    if (event.status === "LIVE") throw new HttpError(400, "This event is already live");

    const roomName = `xonnect-event-${event.id}`;
    const { ingressId, rtmpUrl, streamKey } = await livekit.createEventIngress({
      roomName,
      eventTitle: event.title,
    });

    const updated = await prisma.creatorEvent.update({
      where: { id: event.id },
      data: {
        livekitRoomName: roomName,
        ingressId,
        rtmpUrl,
        streamKey,
        status: "LIVE",
        startedAt: new Date(),
      },
    });

    // rtmpUrl + streamKey go into the creator's broadcasting software (OBS, Streamlabs, etc.)
    res.status(201).json({
      event: updated,
      broadcast: { rtmpUrl, streamKey, roomName },
    });
  })
);

// POST /api/events/:id/livestream/stop — creator ends the stream
router.post(
  "/:id/livestream/stop",
  requireAuth,
  requireCreator,
  asyncHandler(async (req, res) => {
    const event = await prisma.creatorEvent.findUnique({ where: { id: req.params.id } });
    if (!event) throw new HttpError(404, "Event not found");
    if (event.creatorId !== req.creator.id) throw new HttpError(403, "You don't own this event");

    await livekit.stopEventIngress(event.ingressId);
    if (event.livekitRoomName) await livekit.deleteRoom(event.livekitRoomName);

    const updated = await prisma.creatorEvent.update({
      where: { id: event.id },
      data: { status: "ENDED", endedAt: new Date() },
    });

    res.json({ event: updated });
  })
);

// GET /api/events/:id/livestream/token — viewer join token; gated by ticket ownership for paid events
router.get(
  "/:id/livestream/token",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const event = await prisma.creatorEvent.findUnique({ where: { id: req.params.id } });
    if (!event) throw new HttpError(404, "Event not found");
    if (!event.livekitRoomName) throw new HttpError(400, "This event isn't live");

    if (event.isPaid || event.requireTicket) {
      if (!req.user) throw new HttpError(401, "Log in and purchase a ticket to watch this stream");

      const ownsTicket = await prisma.creatorEventTicketPurchase.findFirst({
        where: {
          status: "COMPLETED",
          buyerEmail: req.user.email,
          ticket: { eventId: event.id, access: "STREAM" },
        },
      });
      if (!ownsTicket) throw new HttpError(403, "You need a valid ticket to watch this stream");
    }

    const identity = req.user?.id || `guest-${Date.now()}`;
    const name = req.user?.fullName || req.user?.email || "Guest";

    const token = await livekit.createRoomToken({ roomName: event.livekitRoomName, identity, name });

    res.json({ token, roomName: event.livekitRoomName, wsUrl: wsUrl(process.env.LIVEKIT_HOST) });
  })
);

module.exports = router;
