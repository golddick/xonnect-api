const {
  RoomServiceClient,
  IngressClient,
  EgressClient,
  AccessToken,
  IngressInput,
  EncodedFileOutput,
  EncodedFileType,
  S3Upload,
} = require("livekit-server-sdk");

const roomService = new RoomServiceClient(
  process.env.LIVEKIT_API_URL,
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET
);

const ingressClient = new IngressClient(
  process.env.LIVEKIT_API_URL,
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET
);

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

async function startEventEgress({ eventId, roomName }) {
  const egressClient = new EgressClient(
    process.env.LIVEKIT_API_URL,
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET
  );
  const required = [
    "SUPABASE_S3_ENDPOINT",
    "SUPABASE_S3_REGION",
    "SUPABASE_S3_ACCESS_KEY",
    "SUPABASE_S3_SECRET",
    "SUPABASE_RECORDINGS_BUCKET",
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) throw new Error(`Missing recording environment variables: ${missing.join(", ")}`);

  const filepath = `event-recordings/${eventId}/${eventId}-{time}.mp4`;
  const fileOutput = new EncodedFileOutput({
    fileType: EncodedFileType.MP4,
    filepath,
    output: {
      case: "s3",
      value: new S3Upload({
        accessKey: process.env.SUPABASE_S3_ACCESS_KEY,
        secret: process.env.SUPABASE_S3_SECRET,
        region: process.env.SUPABASE_S3_REGION,
        endpoint: process.env.SUPABASE_S3_ENDPOINT,
        bucket: process.env.SUPABASE_RECORDINGS_BUCKET,
        forcePathStyle: true,
      }),
    },
  });

  const info = await egressClient.startRoomCompositeEgress(roomName, { file: fileOutput }, { layout: "speaker" });
  return { egressId: info.egressId, filepath };
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

module.exports = { createEventIngress, stopEventIngress, deleteRoom, createRoomToken, startEventEgress };
