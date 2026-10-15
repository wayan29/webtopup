const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const databaseUrl = process.env.DATABASE_URL;
const originValue = process.env.SQL_PROFILE_SMOKE_ORIGIN;
assert.ok(databaseUrl, 'DATABASE_URL is required');
assert.ok(originValue, 'SQL_PROFILE_SMOKE_ORIGIN is required');
const database = new URL(databaseUrl);
const databaseName = database.pathname.slice(1);
assert.match(databaseName, /^webtopup_ci_[a-z0-9_]+$/u, 'refusing non-disposable database');
const origin = new URL(originValue);
assert.ok(['127.0.0.1', 'localhost', '::1'].includes(origin.hostname), 'origin must be local');

const apiOrigin = origin.origin;
const headers = { origin: apiOrigin, 'content-type': 'application/json' };

async function request(path, method = 'GET', body, accessToken) {
  return fetch(`${apiOrigin}${path}`, {
    method,
    headers: { ...headers, ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createMember(label) {
  const suffix = crypto.randomUUID();
  const email = `sql-profile-${label}-${suffix}@example.test`;
  const password = `SqlProfile-${crypto.randomBytes(16).toString('hex')}!`;
  const registration = await request('/api/v2/auth/register', 'POST', {
    name: 'SQL Profile Member',
    email,
    password,
  });
  assert.equal(registration.status, 200, `register member: ${registration.status}`);

  const login = await request('/api/v2/auth/member/login', 'POST', { email, password });
  assert.equal(login.status, 200, `login member: ${login.status}`);
  const session = await login.json();
  assert.equal(typeof session.accessToken, 'string');
  return { email, accessToken: session.accessToken };
}

async function main() {
  const [member, other] = await Promise.all([createMember('primary'), createMember('other')]);
  const profilePath = '/api/v2/users/me/profile';

  const initialResponse = await request(profilePath, 'GET', undefined, member.accessToken);
  assert.equal(initialResponse.status, 200, `read profile: ${initialResponse.status}`);
  const initial = (await initialResponse.json()).profile;
  assert.equal(initial.role, 'member');
  assert.match(initial.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  assert.equal(initial.email, member.email);
  assert.equal(initial.phone, '');
  assert.equal(initial.address, '');
  assert.equal(typeof initial.preferences.showBalance, 'boolean');

  const renamedEmail = `SQL-Profile-${crypto.randomUUID()}@Example.Test`;
  const updateResponse = await request(profilePath, 'PUT', {
    name: '  Updated Member  ',
    email: renamedEmail,
    phone: '+62 (812) 3456-7890',
    address: '  Bandung  ',
  }, member.accessToken);
  assert.equal(updateResponse.status, 200, `partial profile update: ${updateResponse.status}`);
  const updated = (await updateResponse.json()).profile;
  assert.equal(updated.name, 'Updated Member');
  assert.equal(updated.email, renamedEmail.toLowerCase());
  assert.equal(updated.phone, '6281234567890');
  assert.equal(updated.address, 'Bandung');
  assert.equal(updated.role, 'member');

  const collision = await request(profilePath, 'PUT', { email: other.email.toUpperCase() }, member.accessToken);
  assert.equal(collision.status, 400, `normalized duplicate email: ${collision.status}`);
  const afterCollision = await request(profilePath, 'GET', undefined, member.accessToken);
  assert.equal((await afterCollision.json()).profile.email, renamedEmail.toLowerCase());

  const clearResponse = await request(profilePath, 'PUT', { phone: '', address: '' }, member.accessToken);
  assert.equal(clearResponse.status, 200, `clear optional values: ${clearResponse.status}`);
  const cleared = (await clearResponse.json()).profile;
  assert.equal(cleared.phone, '');
  assert.equal(cleared.address, '');
  assert.equal(cleared.email, renamedEmail.toLowerCase());

  const invalid = await request(profilePath, 'PUT', { address: 'x'.repeat(201) }, member.accessToken);
  assert.equal(invalid.status, 400, `reject oversized address: ${invalid.status}`);

  console.log(JSON.stringify({
    database: databaseName,
    profileRead: 'passed',
    partialUpdate: 'passed',
    normalizedEmailUniqueness: 'passed',
    optionalFieldClearing: 'passed',
    validationBoundary: 'passed',
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
