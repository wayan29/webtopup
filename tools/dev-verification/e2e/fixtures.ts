import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient } from 'mongodb';

const root = path.resolve(__dirname, '..', '..', '..');

const envFile = async (file: string): Promise<Record<string, string>> => Object.fromEntries(
  (await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    if (index < 1) throw new Error('invalid private fixture environment');
    return [line.slice(0, index), line.slice(index + 1)];
  }),
);

export type FixtureLogin = {
  email: string;
  password: string;
  /** Derived from the manifest role: the channel this fixture is allowed to use. */
  audience: 'member' | 'staff';
  /** Gateway endpoint for the fixture channel, e.g. for use inside page.evaluate. */
  loginEndpoint: '/auth/member/login' | '/auth/staff/login';
  /** Browser login surface for the fixture channel. */
  loginPath: '/login' | '/staff/login';
};

const decodeBase32 = (secret: string): Buffer => {
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of secret) {
    const digit = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(character.toUpperCase());
    if (digit < 0) throw new Error('invalid synthetic TOTP secret');
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      output.push((value >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
};

const currentOtp = (secret: string): string => {
  const input = Buffer.alloc(8);
  input.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(input).digest();
  const offset = digest[19]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24)
    | (digest[offset + 1]! << 16)
    | (digest[offset + 2]! << 8)
    | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
};

export async function loginFixture(alias: string): Promise<FixtureLogin> {
  const [manifest, secrets] = await Promise.all([
    fs.readFile(path.join(root, '.dev-verification', 'fixture-manifest.json'), 'utf8').then((text) => JSON.parse(text) as Array<{ alias: string; fixtureRunId: string; role: 'member' | 'cs' | 'admin' | 'owner' }>),
    envFile(path.join(root, '.dev-verification', 'env', 'node.env')),
  ]);
  const fixture = manifest.find((item) => item.alias === alias);
  if (!fixture) throw new Error('required synthetic fixture alias is unavailable');
  const password = fixture.role === 'member'
    ? secrets.FIXTURE_MEMBER_PASSWORD
    : fixture.role === 'cs'
      ? secrets.FIXTURE_STAFF_PASSWORD
      : secrets.FIXTURE_ADMIN_PASSWORD;
  if (!password) throw new Error('required synthetic fixture credential is unavailable');
  // Login channels are separate and server-enforced: a staff credential posted to the member
  // endpoint is rejected with the generic message, so the fixture must carry its own channel.
  const audience = fixture.role === 'member' ? 'member' as const : 'staff' as const;
  return {
    email: `${fixture.alias}.${fixture.fixtureRunId}@task14.invalid`,
    password,
    audience,
    loginEndpoint: audience === 'staff' ? '/auth/staff/login' : '/auth/member/login',
    loginPath: audience === 'staff' ? '/staff/login' : '/login',
  };
}

/** Read a TOTP only from the marked disposable fixture database, never from shared data. */
export async function fixtureOtp(alias: string): Promise<string> {
  const [fixture, shared] = await Promise.all([
    loginFixture(alias),
    envFile(path.join(root, '.dev-verification', 'env', 'shared.env')),
  ]);
  if (shared.MONGO_DB !== 'webtopup_task14_dev' || shared.LOCAL_DEV_VERIFICATION !== 'true') {
    throw new Error('fixture OTP requires the disposable verification database');
  }
  const mongo = new MongoClient(shared.MONGO_URI!);
  try {
    await mongo.connect();
    const user = await mongo.db(shared.MONGO_DB).collection('users').findOne(
      { email: fixture.email, task14Fixture: true },
      { projection: { twoFactorSecret: 1 } },
    );
    if (typeof user?.twoFactorSecret !== 'string') throw new Error('required synthetic TOTP fixture is unavailable');
    return currentOtp(user.twoFactorSecret);
  } finally {
    await mongo.close();
  }
}
