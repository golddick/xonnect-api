const express = require("express");
const { z } = require("zod");
const { dropid } = require("dropid");
const prisma = require("../lib/prisma");
const { asyncHandler, requireAuth } = require("../middleware/auth");

const router = express.Router();

router.post(
  "/accept",
  requireAuth,
  asyncHandler(async (req, res) => {
    const data = z.object({ accepted: z.literal(true), signature: z.string().trim().min(1) }).parse(req.body);
    const creator = await prisma.$transaction(async (tx) => {
      const creatorData = {
        agreementAccepted: data.accepted,
        agreementSignature: data.signature,
        agreementAcceptedAt: new Date(),
      };

      const createdCreator = req.creator
        ? await tx.creator.update({ where: { id: req.creator.id }, data: creatorData })
        : await tx.creator.create({
            data: {
              id: dropid("crt"),
              profileId: req.user.id,
              ...creatorData,
            },
          });

      if (!req.creator) {
        await tx.profile.update({
          where: { id: req.user.id },
          data: { role: "CREATOR", creatorName: req.user.fullName },
        });
      }

      return createdCreator;
    });

    res.status(req.creator ? 200 : 201).json({ message: "Creator agreement accepted", creator });
  })
);

module.exports = router;