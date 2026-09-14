const express = require("express");
const { z } = require("zod");
const { asyncHandler, requireAuth } = require("../middleware/auth");
const { HttpError } = require("../middleware/errorHandler");
const dropaphi = require("../lib/dropaphi");

const router = express.Router();

const uploadSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1), // MIME type, e.g. "image/jpeg"
  data: z.string().min(1), // base64-encoded file content (no data: prefix)
  folder: z.enum(["avatars", "event-thumbnails", "video-thumbnails", "videos", "receipts"]),
  visibility: z.enum(["PUBLIC", "PRIVATE"]).optional(),
});

// POST /api/uploads — used by the mobile app for avatar/thumbnail/video uploads.
// For large video files, prefer requesting a direct upload URL from DropAphi if they offer one;
// base64 over JSON is fine for images/avatars but inefficient for large video files.
router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { name, type, data, folder, visibility } = uploadSchema.parse(req.body);

    let result;
    try {
      result = await dropaphi.uploadFile({ name, type, base64Data: data, folder, visibility });
    } catch (err) {
      throw new HttpError(502, "File upload failed, please try again");
    }

    res.status(201).json({ url: result.url || result.data?.url, raw: result });
  })
);

module.exports = router;
