const { RoomServiceClient, IngressClient, AccessToken, IngressInput } = require("livekit-server-sdk");

const roomService = new RoomServiceClient(
  process.env.LIVEKIT_API_URL,
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET
);

const ingressClient = new IngressClient(process.env.LIVEKIT_API_URL);

/**
 * Creates a LiveKit room + RTMP ingress for a creator's live event.
 * The creator's broadcasting software (OBS, Streamlabs, etc.) pushes to `url` with `streamKey`;
 * viewers connect to the LiveKit room itself using a viewer access token (see viewerToken below).
 */
async function createEventIngress({ roomName, eventTitle }) {
  await roomService.createRoom({ name: roomName, emptyTimeout: 60 * 30, maxParticipants: 0 });

  const ingress = await ingressClient.createIngress(IngressInput.RTMP_INPUT, {
    name: eventTitle,
    roomName,
    participantIdentity: `creator-${roomName}`,
    participantName: eventTitle,
  });

  return {
    ingressId: ingress.ingressId,
    rtmpUrl: ingress.url, // e.g. rtmp://<host>/x
    streamKey: ingress.streamKey,
    roomName,
  };
}

async function stopEventIngress(ingressId) {
  if (!ingressId) return;
  await ingressClient.deleteIngress(ingressId).catch(() => {});
}

async function deleteRoom(roomName) {
  await roomService.deleteRoom(roomName).catch(() => {});
}

/**
 * Issues a short-lived viewer/creator join token for a LiveKit room.
 * `canPublish` is true only for the creator broadcasting via WebRTC (not needed for RTMP ingress,
 * but useful if you ever support in-app broadcasting instead of OBS/RTMP).
 */
async function createRoomToken({ roomName, identity, name, canPublish = false }) {
  const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity,
    name,
    ttl: "6h",
  });
  token.addGrant({ roomJoin: true, room: roomName, canPublish, canSubscribe: true });
  return token.toJwt();
}

module.exports = { createEventIngress, stopEventIngress, deleteRoom, createRoomToken };
