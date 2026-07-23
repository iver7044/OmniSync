/**
 * services/reviztoAuth.js
 * Implements Revizto's documented OAuth2 flow exactly as confirmed from
 * their docs (developer.revizto.com/docs/v5 - User authentication):
 *
 *   1. Get access code: user visits
 *        https://ws.revizto.com/login?request=accessCode
 *      and copies the code shown (valid 15 minutes, no redirect support).
 *
 *   2. Exchange code -> tokens: POST https://api.{region}.revizto.com/v5/oauth2
 *        body: { code, grant_type: 'authorization_code' }
 *
 *   3. Refresh: POST https://api.{region}.revizto.com/v5/oauth2
 *        body: { grant_type: 'refresh_token', refresh_token }
 *      Both tokens rotate on refresh — the old refresh_token is invalidated.
 *
 * NOTE: The exact JSON shape of the token response (field names, whether
 * `expires_in` is present/seconds) was not shown in the docs excerpt we
 * were given. This code assumes the common OAuth2 shape
 * (access_token, refresh_token, expires_in) matching the old app's
 * working implementation. Verify against a real response and adjust
 * `_parseTokenResponse` if field names differ.
 */
const axios = require('axios');

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function baseUrl(region) {
  return `https://api.${region}.revizto.com/v5/oauth2`;
}

function _parseTokenResponse(data) {
  const now = Date.now();
  const accessLifeMs = (data.expires_in ? data.expires_in * 1000 : ONE_HOUR_MS);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    access_expires_at: new Date(now + accessLifeMs - 60_000), // 60s safety margin
    refresh_expires_at: new Date(now + ONE_MONTH_MS),
  };
}

/**
 * Exchange a one-time access code (from the Revizto login page) for
 * an access/refresh token pair. Must happen within ~15 minutes of the
 * user obtaining the code.
 */
async function exchangeAccessCode(accessCode, region = 'virginia') {
  const { data } = await axios.post(
    baseUrl(region),
    new URLSearchParams({ code: accessCode, grant_type: 'authorization_code' }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return _parseTokenResponse(data);
}

/**
 * Refresh an existing Revizto token pair. Rotates both tokens.
 */
async function refresh(refreshToken, region = 'virginia') {
  const { data } = await axios.post(
    baseUrl(region),
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return _parseTokenResponse(data);
}

module.exports = { exchangeAccessCode, refresh };
