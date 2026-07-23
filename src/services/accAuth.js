/**
 * services/accAuth.js
 * Autodesk Platform Services 3-legged OAuth, adapted from the old
 * accService.js — same APS endpoints, but no longer storing tokens in
 * an in-memory variable. Callers persist the result via tokenStore.
 */
const axios = require('axios');

const APS_BASE = 'https://developer.api.autodesk.com';
const CLIENT_ID = process.env.APS_CLIENT_ID;
const CLIENT_SECRET = process.env.APS_CLIENT_SECRET;
const CALLBACK_URL = process.env.APS_CALLBACK_URL;

function getAuthUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK_URL,
    scope: 'data:read data:write account:read',
    state: state || '',
  });
  return `${APS_BASE}/authentication/v2/authorize?${params.toString()}`;
}

function _basicAuthHeader() {
  return 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
}

function _parseTokenResponse(data) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: new Date(Date.now() + data.expires_in * 1000 - 60_000),
  };
}

async function exchangeCode(code) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: CALLBACK_URL,
  });
  const { data } = await axios.post(`${APS_BASE}/authentication/v2/token`, params.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: _basicAuthHeader(),
    },
  });
  return _parseTokenResponse(data);
}

async function refresh(refreshToken) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const { data } = await axios.post(`${APS_BASE}/authentication/v2/token`, params.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: _basicAuthHeader(),
    },
  });
  return _parseTokenResponse(data);
}

async function getCurrentUser(accessToken) {
  const { data } = await axios.get('https://api.userprofile.autodesk.com/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return data;
}

module.exports = { getAuthUrl, exchangeCode, refresh, getCurrentUser, APS_BASE };
