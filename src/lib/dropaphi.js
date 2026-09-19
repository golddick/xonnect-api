const axios = require("axios");

const client = axios.create({
  baseURL: process.env.DROPAPHI_BASE_URL || "https://dropaphi.xyz/api/v1",
  headers: {
    "DROP-API-Key": process.env.DROPAPHI_API_KEY,
    "Content-Type": "application/json",
  },
  timeout: 15000,
});


/**
 * Sends a numeric OTP to `email`. DropAphi stores and manages the code server-side —
 * we never see or store the raw code ourselves, only whether verifyOtp() later succeeds.
 */
async function sendOtp(email, { length = 6, expiry = 10, brandName = "Xonnect" } = {}) {
  const { data } = await client.post("/otp/send", { email, length, expiry, brandName });
  return data;
}

/**
 * Verifies a code the user entered against DropAphi's stored OTP for that email.
 * NOTE: DropAphi's docs snippet only showed /otp/send — this assumes a matching
 * /otp/verify endpoint with the same request shape. Confirm the exact path/fields
 * against DropAphi's docs and adjust here if it differs.
 */
async function verifyOtp(email, code) {
  const { data } = await client.post("/otp/verify", { email, code });
  return !!(data?.valid ?? data?.success);
}

/**
 * Sends a transactional email (ticket receipts, payout notices, gate-staff credentials, etc).
 */
async function sendEmail({ to, subject, html, text, template, templateData, fromName = "Xonnect", tracking }) {
  const { data } = await client.post("/email/send", {
    to,
    subject,
    html,
    text,
    template,
    templateData,
    fromName,
    tracking: tracking ?? { opens: true, clicks: true },
  });
  return data;
}

/**
 * Uploads a file (base64-encoded) to DropAphi's file storage and returns its public URL.
 * Use for avatars, event/video thumbnails, and payout receipts.
 */
async function uploadFile({ name, type, base64Data, visibility = "PUBLIC" }) {
  const { data } = await client.post("/files/upload", {
    name,
    type,
    data: base64Data,
    metadata: { visibilit },
  });
  return data; // expected to include a `url` field per DropAphi's response
}

module.exports = { sendOtp, verifyOtp, sendEmail, uploadFile };
