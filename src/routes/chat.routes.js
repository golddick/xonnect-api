const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { asyncHandler, optionalAuth } = require("../middleware/auth");
const { dropid } = require("dropid");

const router = express.Router();
const subscribers = new Map();
const reactions = ["👍", "❤️", "🔥", "😂", "👏"];
const chatKinds = new Set(["event", "folder", "video", "stream"]);

function channelKey(kind, id) {
  return `${kind}:${id}`;
}

function channelParams(req, res) {
  const kind = String(req.params.kind || "");
  const id = String(req.params.id || "").trim();
  if (!chatKinds.has(kind) || !id) {
    res.status(400).json({ message: "Invalid chat channel" });
    return null;
  }
  return { kind, id };
}

function serialize(message) {
  return {
    id: message.id,
    name: message.name,
    handle: message.handle,
    time: message.createdAt instanceof Date ? message.createdAt.toISOString() : message.createdAt,
    text: message.text,
    reactions: message.reactions || Object.fromEntries(reactions.map((reaction) => [reaction, 0])),
  };
}

function broadcast(kind, id, message) {
  const listeners = subscribers.get(channelKey(kind, id));
  if (!listeners) return;
  const payload = `event: message\ndata: ${JSON.stringify({ message: serialize(message) })}\n\n`;
  for (const response of listeners) response.write(payload);
}

router.get("/:kind/:id", optionalAuth, asyncHandler(async (req, res) => {
  const channel = channelParams(req, res);
  if (!channel) return;

  const messages = await prisma.chatMessage.findMany({
    where: { kind: channel.kind, channelId: channel.id },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  res.json({ messages: messages.map(serialize) });
}));

router.post("/:kind/:id", optionalAuth, asyncHandler(async (req, res) => {
  const channel = channelParams(req, res);
  if (!channel) return;

  const { text, clientId } = z.object({ text: z.string().trim().min(1).max(500), clientId: z.string().trim().min(1).max(100).optional() }).parse(req.body);
  const name = req.user?.fullName || req.user?.email || "Unknown";
  const handle = name === "Unknown" ? "@unknown" : `@${String(name).toLowerCase().replace(/\s+/g, "")}`;

  if (clientId) {
    const existing = await prisma.chatMessage.findUnique({ where: { id: clientId } });
    if (existing && existing.kind === channel.kind && existing.channelId === channel.id) {
      return res.status(200).json({ message: serialize(existing) });
    }
  }

  const message = await prisma.chatMessage.create({
    data: {
      id: clientId || dropid("chat"),
      kind: channel.kind,
      channelId: channel.id,
      name,
      handle,
      text,
      reactions: Object.fromEntries(reactions.map((reaction) => [reaction, 0])),
    },
  });
  broadcast(channel.kind, channel.id, message);
  res.status(201).json({ message: serialize(message) });
}));

router.patch("/:kind/:id", optionalAuth, asyncHandler(async (req, res) => {
  const channel = channelParams(req, res);
  if (!channel) return;

  const { messageId, reaction } = z.object({ messageId: z.string().min(1), reaction: z.enum(reactions) }).parse(req.body);
  const message = await prisma.chatMessage.findFirst({ where: { id: messageId, kind: channel.kind, channelId: channel.id } });
  if (!message) return res.status(404).json({ message: "Chat message not found" });
  const nextReactions = { ...(message.reactions || {}) };
  nextReactions[reaction] = Number(nextReactions[reaction] || 0) + 1;
  const updated = await prisma.chatMessage.update({ where: { id: message.id }, data: { reactions: nextReactions } });
  broadcast(channel.kind, channel.id, updated);
  res.json({ message: serialize(updated) });
}));

router.get("/:kind/:id/sse", asyncHandler(async (req, res) => {
  const key = channelKey(req.params.kind, req.params.id);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const listeners = subscribers.get(key) || new Set();
  listeners.add(res);
  subscribers.set(key, listeners);
  res.write(`event: ready\ndata: {}\n\n`);

  const heartbeat = setInterval(() => res.write(`event: ping\ndata: {}\n\n`), 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    listeners.delete(res);
    if (listeners.size === 0) subscribers.delete(key);
  });
}));

module.exports = router;
