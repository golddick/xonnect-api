const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { asyncHandler, requireAuth } = require("../middleware/auth");

const router = express.Router();

function serialize(message) {
  return {
    id: message.id,
    from: message.from,
    text: message.text,
    time: message.createdAt.toISOString(),
  };
}

router.get("/messages", requireAuth, asyncHandler(async (req, res) => {
  const messages = await prisma.supportMessage.findMany({
    where: { profileId: req.user.id },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  res.json({ messages: messages.map(serialize) });
}));

router.post("/messages", requireAuth, asyncHandler(async (req, res) => {
  const { text } = z.object({ text: z.string().trim().min(1).max(2000) }).parse(req.body);
  const message = await prisma.supportMessage.create({
    data: { profileId: req.user.id, from: "me", text },
  });
  res.status(201).json({ message: serialize(message) });
}));

module.exports = router;