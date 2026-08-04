#!/usr/bin/env node

const path = require('path');
const { createRequire } = require('module');

const serverRequire = createRequire(path.join(process.cwd(), 'server/package.json'));
const bcrypt = serverRequire('bcrypt');
const mongoose = serverRequire('mongoose');

const mongoUri = (process.env.MONGO_URI || '').trim();
const mongoDb = (process.env.MONGO_DB || '').trim();
const adminEmail = process.env.SMOKE_EMAIL || 'api-v2-smoke-admin@danayasa.biz.id';
const adminPassword = process.env.SMOKE_PASSWORD || 'ApiV2CiAdmin2909!';
const memberEmail = process.env.SMOKE_MEMBER_EMAIL || 'api-v2-smoke-member@danayasa.biz.id';
const memberPassword = process.env.SMOKE_MEMBER_PASSWORD || 'ApiV2MemberSmoke2909!';

if (!mongoUri) {
  console.error('MONGO_URI is required to seed API v2 CI fixtures.');
  process.exit(1);
}

const permissions = {
  viewDashboard: true,
  viewReports: true,
  viewTransactions: true,
  processManualTransaction: true,
  viewDeposits: true,
  approveDeposits: true,
  viewProducts: true,
  manageProducts: true,
  viewPayment: true,
  managePayment: true,
  viewUsers: true,
  manageUsers: true,
  viewTeam: true,
  manageTeam: true,
  viewSettings: true,
  manageSettings: true,
  viewVendors: true,
  manageVendors: true,
};

async function upsertUser(users, user) {
  const password = await bcrypt.hash(user.password, 10);
  await users.updateOne(
    { email: user.email },
    {
      $set: {
        email: user.email,
        name: user.name,
        role: user.role,
        level: user.level,
        password,
        active: true,
        permissions: user.permissions || {},
        preferences: {
          emailNotifications: true,
          smsNotifications: false,
          showBalance: true,
          uiTheme: 'ember-premium',
        },
        sessionVersion: 0,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        balance: user.balance || 0,
        points: 0,
        createdAt: new Date(),
        __v: 0,
      },
    },
    { upsert: true },
  );
}

async function main() {
  if (/wayandayan22@gmail\.com/i.test(adminEmail) || /wayandayan22@gmail\.com/i.test(memberEmail)) {
    throw new Error('refusing to seed smoke fixtures over the owner email');
  }
  await mongoose.connect(mongoUri, mongoDb ? { dbName: mongoDb } : undefined);
  const users = mongoose.connection.db.collection('users');

  await upsertUser(users, {
    email: adminEmail,
    password: adminPassword,
    name: 'API v2 CI Admin',
    role: 'admin',
    level: 'platinum',
    balance: 0,
    permissions,
  });

  await upsertUser(users, {
    email: memberEmail,
    password: memberPassword,
    name: 'API v2 CI Member',
    role: 'member',
    level: 'basic',
    balance: 0,
  });

  await mongoose.disconnect();
  console.log(`Seeded API v2 smoke fixtures for ${adminEmail} and ${memberEmail}.`);
}

main().catch(async (error) => {
  console.error(error.message || error);
  try {
    await mongoose.disconnect();
  } catch {
    // best effort cleanup
  }
  process.exit(1);
});
