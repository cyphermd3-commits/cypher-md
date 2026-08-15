const { Redis } = require('@upstash/redis');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

let redis;

function initRedis(url, token) {
  url = (url || '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
  token = (token || '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
  if (!url.startsWith('https://')) throw new Error(`Invalid Redis URL: "${url}"`);
  if (!token) throw new Error('Redis token is empty after sanitization');
  redis = new Redis({ url, token });
  return redis;
}

async function useUpstashAuthState(phoneNumber) {
  const credsKey = `auth:creds:${phoneNumber}`;

  const raw = await redis.get(credsKey);
  let creds = raw ? JSON.parse(JSON.stringify(raw), BufferJSON.reviver) : initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        if (!ids?.length) return {};
        const keys = ids.map(id => `auth:key:${phoneNumber}:${type}:${id}`);
        const values = await redis.mget(...keys);
        const result = {};
        for (let i = 0; i < ids.length; i++) {
          if (values[i] != null) {
            result[ids[i]] = JSON.parse(JSON.stringify(values[i]), BufferJSON.reviver);
          }
        }
        return result;
      },
      set: async (data) => {
        const pipeline = redis.pipeline();
        for (const type in data) {
          for (const id in data[type]) {
            const value = JSON.parse(JSON.stringify(data[type][id]), BufferJSON.reviver);
            const key = `auth:key:${phoneNumber}:${type}:${id}`;
            pipeline.set(key, JSON.stringify(value, BufferJSON.replacer));
          }
        }
        await pipeline.exec();
      }
    }
  };

  const saveCreds = async () => {
    await redis.set(credsKey, JSON.stringify(creds, BufferJSON.replacer));
  };

  return { state, saveCreds };
}

async function loadSettings() {
  const keys = [];
  let cursor = 0;
  do {
    const [next, batch] = await redis.scan(cursor, { match: 'bot:setting:*', count: 100 });
    cursor = parseInt(next);
    keys.push(...batch);
  } while (cursor !== 0);
  if (!keys.length) return {};
  const values = await redis.mget(...keys);
  const settings = {};
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i].replace('bot:setting:', '');
    settings[key] = values[i];
  }
  return settings;
}

async function saveSetting(key, value) {
  await redis.set(`bot:setting:${key}`, value);
}

async function deleteAuthSession(phoneNumber) {
  await redis.del(`auth:creds:${phoneNumber}`);
  let cursor = 0;
  do {
    const [next, keys] = await redis.scan(cursor, { match: `auth:key:${phoneNumber}:*`, count: 100 });
    cursor = parseInt(next);
    if (keys.length) await redis.del(...keys);
  } while (cursor !== 0);
}

async function deleteContactSession(phoneNumber, targetJid) {
  const jid = targetJid.replace(/[^0-9]/g, '');
  let count = 0;
  for (const pattern of [`auth:key:${phoneNumber}:session:*${jid}*`, `auth:key:${phoneNumber}:lid-mapping:*${jid}*`]) {
    let cursor = 0;
    do {
      const [next, keys] = await redis.scan(cursor, { match: pattern, count: 100 });
      cursor = parseInt(next);
      if (keys.length) { await redis.del(...keys); count += keys.length; }
    } while (cursor !== 0);
  }
  if (count) console.log(`[REDIS] deleted ${count} session keys for ${targetJid}`);
  else console.log(`[REDIS] no session keys for ${targetJid}`);
  return count;
}

async function getStoredPhoneNumbers() {
  const numbers = [];
  let cursor = 0;
  do {
    const [next, keys] = await redis.scan(cursor, { match: 'auth:creds:*', count: 100 });
    cursor = parseInt(next);
    for (const k of keys) numbers.push(k.replace('auth:creds:', ''));
  } while (cursor !== 0);
  return [...new Set(numbers)];
}

async function loadBotState(phoneNumber) {
  try {
    const keys = [];
    let cursor = 0;
    do {
      const [next, batch] = await redis.scan(cursor, { match: `bot:setting:${phoneNumber}:*`, count: 100 });
      cursor = parseInt(next);
      keys.push(...batch);
    } while (cursor !== 0);

    if (!keys.length) {
      // Migrate legacy single-blob key
      const raw = await redis.get(`bot:state:${phoneNumber}`);
      if (raw) {
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (data && typeof data === 'object') {
          await saveBotState(phoneNumber, data);
          await redis.del(`bot:state:${phoneNumber}`);
          console.log(`[REDIS] migrated legacy bot state for ${phoneNumber} into structured keys`);
          return data;
        }
      }
      return null;
    }

    const values = await redis.mget(...keys);
    const state = {};
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i].replace(`bot:setting:${phoneNumber}:`, '');
      const val = values[i];
      state[key] = typeof val === 'string' ? JSON.parse(val) : val;
    }
    return state;
  } catch { return null; }
}

async function saveBotState(phoneNumber, data) {
  if (!data || typeof data !== 'object') return;
  const pipeline = redis.pipeline();
  for (const [key, value] of Object.entries(data)) {
    pipeline.set(`bot:setting:${phoneNumber}:${key}`, JSON.stringify(value));
  }
  await pipeline.exec();
}

async function loadLicenses() {
  try {
    const keys = await redis.keys('bot:setting:license:*');
    const out = {};
    for (const k of keys) {
      const keyName = k.replace('bot:setting:license:', '');
      const h = await redis.hgetall(k);
      if (h) out[keyName] = { number: h.number || null, days: parseInt(h.days, 10) || 30, createdAt: parseInt(h.createdAt, 10) || null };
    }
    return out;
  } catch { return {}; }
}

async function saveLicenses(data) {
  for (const [key, v] of Object.entries(data)) {
    await redis.hset(`bot:setting:license:${key}`, {
      number: v.number || '',
      days: v.days || 30,
      createdAt: v.createdAt || Date.now(),
    });
  }
}

const REDEEM_LICENSE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return nil end
local number = redis.call('HGET', KEYS[1], 'number')
if number and number ~= ARGV[1] then return 'taken' end
if not number or number == '' then redis.call('HSET', KEYS[1], 'number', ARGV[1]) end
return redis.call('HGET', KEYS[1], 'days')
`;

async function redeemLicense(key, phoneNumber) {
  try {
    const res = await redis.eval(REDEEM_LICENSE_LUA, [`bot:setting:license:${key}`], [phoneNumber]);
    if (res === null || res === undefined) return null;
    if (res === 'taken') return null;
    return { key, number: phoneNumber, days: parseInt(res, 10) || 30 };
  } catch { return null; }
}

module.exports = { initRedis, useUpstashAuthState, loadSettings, saveSetting, deleteAuthSession, deleteContactSession, getStoredPhoneNumbers, loadBotState, saveBotState, loadLicenses, saveLicenses, redeemLicense, getRedis: () => redis };
