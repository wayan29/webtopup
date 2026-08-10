#!/usr/bin/env node
// Buat/promosikan user OWNER (role tertinggi) — mirror struktur admin yang sudah login OK.
const path = require('path');
const { createRequire } = require('module');
const serverRequire = createRequire(path.join(process.cwd(), 'server/package.json'));
const bcrypt = serverRequire('bcrypt');
const mongoose = serverRequire('mongoose');

const MONGO_URI = (process.env.MONGO_URI || '').trim();
const MONGO_DB = (process.env.MONGO_DB || 'POBB').trim();
const EMAIL = (process.env.OWNER_EMAIL || '').trim();
const PASSWORD = (process.env.OWNER_PASSWORD || '').trim();
const NAME = (process.env.OWNER_NAME || 'Owner').trim();

if (!MONGO_URI || !EMAIL || !PASSWORD) { console.error('Butuh MONGO_URI, OWNER_EMAIL dan OWNER_PASSWORD'); process.exit(1); }

(async () => {
  await mongoose.connect(MONGO_URI, { dbName: MONGO_DB });
  const users = mongoose.connection.collection('users');
  const admin = await users.findOne({ role: 'admin' });
  const hash = await bcrypt.hash(PASSWORD, 12);
  const now = new Date();
  const ownerDoc = {
    email: EMAIL,
    name: NAME,
    role: 'owner',
    level: (admin && admin.level) || 'platinum',
    password: hash,
    active: true,
    balance: 0,
    points: 0,
    sessionVersion: 0,
    permissions: (admin && admin.permissions) || {},
    preferences: (admin && admin.preferences) || { emailNotifications: true, smsNotifications: false, showBalance: true, uiTheme: 'ember-premium' },
    twoFactorEnrollmentRequiredAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
    createdAt: now,
    updatedAt: now,
    __v: 0,
  };
  const before = await users.findOne({ email: EMAIL });
  const res = await users.updateOne({ email: EMAIL }, { $set: ownerDoc }, { upsert: true });
  console.log(`${before ? 'UPDATED' : 'CREATED'} owner -> ${EMAIL}  (matched=${res.matchedCount} modified=${res.modifiedCount} upserted=${res.upsertedId || '-'})`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
