function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

function creatorPlatformNotificationTemplate({ fullName, message }) {
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.6"><p>Hi ${escapeHtml(fullName || "there")},</p><p>${escapeHtml(message).replace(/\n/g, "<br>")}</p><p>Best regards,<br>Xonnect</p></body></html>`
}

function ticketReceiptTemplate({ fullName, eventTitle, ticketType, ticketCode, quantity, amount, watchUrl }) {
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.6"><h2>Your Xonnect ticket is confirmed</h2><p>Hi ${escapeHtml(fullName || "there")},</p><p>Your ticket for <strong>${escapeHtml(eventTitle)}</strong> is ready.</p><p>Ticket type: ${escapeHtml(ticketType)}<br>Quantity: ${quantity}<br>Ticket code: <strong>${escapeHtml(ticketCode)}</strong><br>Total: ${escapeHtml(amount)}</p>${watchUrl ? `<p><a href="${escapeHtml(watchUrl)}">Watch event</a></p>` : ""}<p>Present your ticket code at the venue or use it for stream access.</p><p>Best regards,<br>Xonnect</p></body></html>`
}

function eventLiveNotificationTemplate({ fullName, eventTitle, watchUrl, location }) {
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.6"><h2>${escapeHtml(eventTitle)} is live</h2><p>Hi ${escapeHtml(fullName || "there")},</p><p>The event is now live${location ? ` from ${escapeHtml(location)}` : ""}.</p><p><a href="${escapeHtml(watchUrl)}">Watch now</a></p><p>Best regards,<br>Xonnect</p></body></html>`
}

function checkInCredentialsTemplate({ fullName, eventTitle, gateName, username, temporaryPassword }) {
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.6"><h2>Your Xonnect gate check-in access</h2><p>Hi ${escapeHtml(fullName)},</p><p>You have been added as gate staff for <strong>${escapeHtml(eventTitle)}</strong>.</p><p>Gate: ${escapeHtml(gateName)}<br>Username: <strong>${escapeHtml(username)}</strong><br>Temporary password: <strong>${escapeHtml(temporaryPassword)}</strong></p><p>Keep these credentials private. You will be asked to change the password on first login.</p><p>Best regards,<br>Xonnect</p></body></html>`
}

module.exports = {
  creatorPlatformNotificationTemplate,
  ticketReceiptTemplate,
  eventLiveNotificationTemplate,
  checkInCredentialsTemplate,
}
