/**
 * services/authManager.js
 * The single place that decides "is this user's token still good, or do
 * we need to refresh it" for both ACC and Revizto. Every API call in the
 * app should go through getValidAccToken/getValidReviztoToken rather than
 * touching tokenStore or the *Auth modules directly.
 */
const tokenStore = require('./tokenStore');
const accAuth = require('./accAuth');
const reviztoAuth = require('./reviztoAuth');

class ReconnectRequiredError extends Error {
  constructor(provider, reason) {
    super(`${provider} reconnect required: ${reason}`);
    this.provider = provider;
    this.reason = reason;
  }
}

// ─── ACC ──────────────────────────────────────────────────────────

async function getValidAccToken(userId) {
  const tokens = await tokenStore.getAccTokens(userId);
  if (!tokens) throw new ReconnectRequiredError('acc', 'not connected');

  if (new Date(tokens.expires_at) > new Date()) {
    return tokens.access_token;
  }

  try {
    const refreshed = await accAuth.refresh(tokens.refresh_token);
    await tokenStore.saveAccTokens(userId, {
      ...refreshed,
      autodesk_user_id: tokens.autodesk_user_id,
      autodesk_email: tokens.autodesk_email,
    });
    return refreshed.access_token;
  } catch (err) {
    throw new ReconnectRequiredError('acc', err.response?.data?.error_description || err.message);
  }
}

// ─── Revizto ──────────────────────────────────────────────────────

async function getValidReviztoToken(userId) {
  const tokens = await tokenStore.getReviztoTokens(userId);
  if (!tokens) throw new ReconnectRequiredError('revizto', 'not connected');

  if (new Date(tokens.refresh_expires_at) <= new Date()) {
    throw new ReconnectRequiredError('revizto', 'refresh token expired (~monthly) — get a new access code');
  }

  if (new Date(tokens.access_expires_at) > new Date()) {
    return tokens.access_token;
  }

  try {
    const refreshed = await reviztoAuth.refresh(tokens.refresh_token, tokens.region);
    await tokenStore.saveReviztoTokens(userId, { ...refreshed, region: tokens.region });
    return refreshed.access_token;
  } catch (err) {
    // -206 or similar => refresh token itself is dead, needs a fresh access code
    await tokenStore.clearReviztoTokens(userId);
    throw new ReconnectRequiredError('revizto', err.response?.data?.message || err.message);
  }
}

module.exports = { getValidAccToken, getValidReviztoToken, ReconnectRequiredError };
