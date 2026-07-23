/**
 * services/emailService.js
 * Generic SMTP email sending (via nodemailer) — works with Gmail,
 * SendGrid, Postmark, Resend's SMTP relay, or an in-house mail server,
 * rather than locking into one vendor's proprietary API. If SMTP env
 * vars aren't set, isConfigured() returns false and callers should treat
 * "added to the team" and "email sent" as separate outcomes — the person
 * can still sign in even if the email never went out.
 */
const nodemailer = require('nodemailer');

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function _transport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendInviteEmail({ toEmail, invitedByEmail, appUrl, role }) {
  if (!isConfigured()) {
    throw new Error('SMTP not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS in .env to send invite emails.');
  }
  const transport = _transport();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  await transport.sendMail({
    from,
    to: toEmail,
    subject: `You've been added to Revizto ↔ ACC Sync`,
    text: `${invitedByEmail} added you as a ${role} on Revizto ↔ ACC Sync.\n\nSign in here: ${appUrl}\n\nJust enter your email (${toEmail}) — no password needed.`,
    html: `<p>${invitedByEmail} added you as a <strong>${role}</strong> on Revizto ↔ ACC Sync.</p>
           <p><a href="${appUrl}">Sign in here</a> — just enter your email (${toEmail}), no password needed.</p>`,
  });
}

module.exports = { isConfigured, sendInviteEmail };
