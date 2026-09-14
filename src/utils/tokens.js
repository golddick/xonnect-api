const jwt = require("jsonwebtoken");
const crypto = require("crypto");

function signAuthToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "30d",
  });
}

function verifyAuthToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

// Short-lived tokens for email verification / password reset (stored in VerificationToken table).
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}


// Human-friendly codes for tickets / access codes, e.g. XON-7F3K9Q
function shortCode(len = 8) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return out;
}

module.exports = { signAuthToken, verifyAuthToken, randomToken, shortCode };
