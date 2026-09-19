const express = require("express");
const prisma = require("../lib/prisma");
const { asyncHandler, requireAuth } = require("../middleware/auth");

const router = express.Router();

function serialize(notification) {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    subtitle: notification.subtitle,
    avatar: notification.avatar,
    time: notification.createdAt.toISOString(),
    read: Boolean(notification.readAt),
  };
}

router.get("/", requireAuth, asyncHandler(async (req, res) => {
  const notifications = await prisma.notification.findMany({
    where: { profileId: req.user.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json({ notifications: notifications.map(serialize) });
}));

router.post("/read", requireAuth, asyncHandler(async (req, res) => {
  await prisma.notification.updateMany({
    where: { profileId: req.user.id, readAt: null },
    data: { readAt: new Date() },
  });
  res.json({ ok: true });
}));

router.delete("/:id", requireAuth, asyncHandler(async (req, res) => {
  await prisma.notification.deleteMany({ where: { id: req.params.id, profileId: req.user.id } });
  res.json({ ok: true });
}));

module.exports = router;