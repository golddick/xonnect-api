const express = require("express");
const prisma = require("../lib/prisma");
const { asyncHandler } = require("../middleware/auth");

const router = express.Router();

// GET /api/categories
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const categories = await prisma.category.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
    });
    res.json({ categories });
  })
);

module.exports = router;
