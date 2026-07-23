const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAdmin } = require('./auth');
const emailService = require('../services/emailService');

const VALID_ROLES = ['admin', 'standard'];

router.get('/api/team', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id, email, role, created_at FROM users ORDER BY created_at ASC');
  res.json({ members: rows, emailConfigured: emailService.isConfigured() });
});

router.post('/api/team/invite', requireAdmin, async (req, res) => {
  const { email, role, sendEmail } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const finalRole = VALID_ROLES.includes(role) ? role : 'standard';
  const normalizedEmail = email.toLowerCase().trim();

  // Adds (or updates the role of) the user immediately — this IS the
  // access grant. Email, if requested, is just a notification on top.
  const { rows } = await pool.query(
    `INSERT INTO users (email, role) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role
     RETURNING id, email, role`,
    [normalizedEmail, finalRole]
  );
  const member = rows[0];

  let emailSent = false;
  let emailError = null;
  if (sendEmail) {
    try {
      const appUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
      await emailService.sendInviteEmail({
        toEmail: normalizedEmail,
        invitedByEmail: req.session.userEmail,
        appUrl,
        role: finalRole,
      });
      emailSent = true;
    } catch (err) {
      emailError = err.message;
    }
  }

  await pool.query(
    'INSERT INTO invites (email, role, invited_by, email_sent, email_error) VALUES ($1, $2, $3, $4, $5)',
    [normalizedEmail, finalRole, req.session.userId, emailSent, emailError]
  );

  res.json({ member, emailSent, emailError });
});

router.patch('/api/team/:id/role', requireAdmin, async (req, res) => {
  const { role } = req.body;
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
  if (Number(req.params.id) === req.session.userId && role !== 'admin') {
    return res.status(400).json({ error: "You can't demote yourself — have another admin do it." });
  }
  const { rows } = await pool.query('UPDATE users SET role = $2 WHERE id = $1 RETURNING id, email, role', [req.params.id, role]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json({ member: rows[0] });
});

module.exports = router;
