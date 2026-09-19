const express = require("express");
const { WebhookReceiver, EgressStatus } = require("livekit-server-sdk");
const prisma = require("../lib/prisma");
const { startEventEgress } = require("../lib/livekit");
const dropaphi = require("../lib/dropaphi");
const { eventLiveNotificationTemplate } = require("../utils/email-templates");

const router = express.Router();

function getLiveKitReceiver() {
  const apiKey = (process.env.LIVEKIT_API_KEY || process.env.LIVEKIT_WEBHOOK_API_KEY || "").trim();
  const apiSecret = (process.env.LIVEKIT_API_SECRET || process.env.LIVEKIT_WEBHOOK_SECRET || "").trim();
  if (!apiKey || !apiSecret) throw new Error("Missing LiveKit webhook credentials");
  return new WebhookReceiver(apiKey, apiSecret);
}

function dateFromSeconds(value) {
  return new Date(Number(value) * 1000);
}

async function findEvent(payload) {
  const roomName = payload.roomName || payload.egressRoomName;
  if (payload.ingressId) {
    const event = await prisma.creatorEvent.findFirst({ where: { ingressId: payload.ingressId } });
    if (event) return event;
  }
  if (roomName) {
    const event = await prisma.creatorEvent.findFirst({ where: { livekitRoomName: roomName } });
    if (event) return event;
  }
  if (payload.streamKey) {
    return prisma.creatorEvent.findFirst({ where: { streamKey: payload.streamKey } });
  }
  return null;
}

async function notifyEventLive(event) {
  const followers = await prisma.creatorFollow.findMany({
    where: { creatorId: event.creatorId, status: "active" },
    select: { followerProfile: { select: { email: true, fullName: true } } },
  });
  const purchasers = await prisma.creatorEventTicketPurchase.findMany({
    where: { status: "COMPLETED", ticket: { eventId: event.id } },
    select: { buyerEmail: true, buyerName: true },
  });
  const watchUrl = `${process.env.APP_BASE_URL || "http://localhost:3000"}/tv/watch/event/${event.id}`;
  const location = event.locationFullAddress || event.locationName || event.address || event.locationCountry || null;
  const recipients = [
    ...followers.map(({ followerProfile }) => ({ email: followerProfile.email, fullName: followerProfile.fullName })),
    ...purchasers.map((purchaser) => ({ email: purchaser.buyerEmail, fullName: purchaser.buyerName })),
  ];

  await Promise.allSettled(recipients.map((recipient) =>
    dropaphi.sendEmail({
      to: recipient.email,
      subject: `${event.title} is live on Xonnect`,
      html: eventLiveNotificationTemplate({
        fullName: recipient.fullName,
        eventTitle: event.title,
        watchUrl,
        location,
      }),
      text: `${event.title} is live. Watch now: ${watchUrl}`,
      fromName: "Xonnect",
    }).catch((error) => console.error("Live event notification failed:", error))
  ));
}

router.post("/livekit", async (req, res, next) => {
  try {
    const body = typeof req.body === "string" ? req.body : Buffer.from(req.body || "").toString("utf8");
    const authHeader = req.headers.authorization || undefined;
    const webhookEvent = await getLiveKitReceiver().receive(body, authHeader);
    const event = await findEvent({
      ingressId: webhookEvent.ingressInfo?.ingressId,
      roomName: webhookEvent.ingressInfo?.roomName || webhookEvent.room?.name,
      streamKey: webhookEvent.ingressInfo?.streamKey,
      egressRoomName: webhookEvent.egressInfo?.roomName,
    });

    if (!event) return res.status(404).json({ message: "Creator event not found for webhook" });

    const now = dateFromSeconds(webhookEvent.createdAt);
    const updates = {};
    if (webhookEvent.ingressInfo) {
      updates.ingressId = webhookEvent.ingressInfo.ingressId;
      updates.streamKey = webhookEvent.ingressInfo.streamKey;
      updates.rtmpUrl = webhookEvent.ingressInfo.url;
      updates.livekitRoomName = webhookEvent.ingressInfo.roomName;
    }

    const stale = event.updatedAt && now.getTime() < event.updatedAt.getTime();
    switch (webhookEvent.event) {
      case "ingress_started":
        updates.status = "LIVE";
        updates.startedAt = now;
        break;
      case "ingress_ended":
        updates.status = "ENDED";
        updates.endedAt = now;
        break;
      case "room_started":
        if (!stale) {
          updates.status = "LIVE";
          updates.startedAt = now;
          updates.currentViewersCount = 0;
          if (event.recordingEnabled && !event.recordingAssetId) {
            try {
              const roomName = event.livekitRoomName || webhookEvent.room?.name || `creator-event-${event.id}`;
              const egress = await startEventEgress({ eventId: event.id, roomName });
              updates.recordingAssetId = egress.egressId;
              updates.recordingStatus = "RECORDING";
              updates.recordingStartedAt = now;
            } catch (error) {
              console.error("Failed to start event egress:", error);
              updates.recordingStatus = "FAILED";
            }
          }
        }
        break;
      case "room_finished":
        if (!stale) {
          updates.status = "ENDED";
          updates.endedAt = now;
          updates.currentViewersCount = 0;
        }
        break;
      case "participant_joined": {
        const viewers = typeof webhookEvent.room?.numParticipants === "number"
          ? webhookEvent.room.numParticipants
          : (event.currentViewersCount || 0) + 1;
        updates.currentViewersCount = viewers;
        updates.viewsCount = { increment: 1 };
        updates.peakViewersCount = Math.max(event.peakViewersCount || 0, viewers);
        break;
      }
      case "participant_left":
      case "participant_connection_aborted": {
        const viewers = typeof webhookEvent.room?.numParticipants === "number"
          ? webhookEvent.room.numParticipants
          : Math.max((event.currentViewersCount || 0) - 1, 0);
        updates.currentViewersCount = viewers;
        updates.peakViewersCount = Math.max(event.peakViewersCount || 0, viewers);
        break;
      }
      case "egress_started":
        updates.recordingStatus = "RECORDING";
        if (webhookEvent.egressInfo?.egressId && !event.recordingAssetId) updates.recordingAssetId = webhookEvent.egressInfo.egressId;
        break;
      case "egress_updated": {
        const status = webhookEvent.egressInfo?.status;
        if (status === EgressStatus.EGRESS_ACTIVE) updates.recordingStatus = "RECORDING";
        if (status === EgressStatus.EGRESS_ENDING) updates.recordingStatus = "PROCESSING";
        if (status === EgressStatus.EGRESS_FAILED || status === EgressStatus.EGRESS_ABORTED) updates.recordingStatus = "FAILED";
        break;
      }
      case "egress_ended": {
        const info = webhookEvent.egressInfo;
        const file = info?.fileResults?.[0];
        const failed = info?.status === EgressStatus.EGRESS_FAILED || info?.status === EgressStatus.EGRESS_ABORTED;
        updates.recordingEndedAt = now;
        if (file?.filename && !failed) {
          updates.recordedVideoUrl = file.filename;
          updates.recordingStatus = "READY";
          updates.hasRecordedVideo = true;
        } else {
          updates.recordingStatus = "FAILED";
        }
        break;
      }
      default:
        break;
    }

    const updated = await prisma.creatorEvent.update({ where: { id: event.id }, data: updates });
    if (updated.status === "LIVE" && event.status !== "LIVE") await notifyEventLive(updated);

    return res.json({ message: "LiveKit webhook processed", event: updated, webhookEvent: webhookEvent.event });
  } catch (error) {
    console.error("LiveKit webhook error:", error);
    return next(error);
  }
});

module.exports = router;
