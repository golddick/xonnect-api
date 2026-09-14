const axios = require("axios");
const crypto = require("crypto");

const client = axios.create({
  baseURL: "https://api.paystack.co",
  headers: {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json",
  },
  timeout: 15000,
});

/**
 * Starts a Paystack transaction. `amount` is in the smallest currency unit (kobo for NGN),
 * so multiply Naira amounts by 100 before calling this.
 */
async function initializeTransaction({ email, amountKobo, reference, callbackUrl, metadata }) {
  const { data } = await client.post("/transaction/initialize", {
    email,
    amount: amountKobo,
    reference,
    callback_url: callbackUrl,
    metadata,
  });
  return data.data; // { authorization_url, access_code, reference }
}

async function verifyTransaction(reference) {
  const { data } = await client.get(`/transaction/verify/${encodeURIComponent(reference)}`);
  return data.data; // { status: 'success' | ..., amount, reference, metadata, ... }
}

/**
 * Validates the `x-paystack-signature` header against the raw request body.
 * Must be computed over the raw (unparsed) body — see the webhook route in server.js.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const hash = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(rawBody).digest("hex");
  return hash === signatureHeader;
}

module.exports = { initializeTransaction, verifyTransaction, verifyWebhookSignature };
