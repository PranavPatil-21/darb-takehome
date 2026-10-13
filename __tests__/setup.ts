// Deterministic timezone so date-proximity assertions do not drift with the runner's TZ.
process.env.TZ = 'UTC';

// Point the default Prisma client (the one the route handlers use) at the throwaway test
// database created in global-setup. Must happen before any module imports lib/prisma.
process.env.DATABASE_URL = 'file:./test.db';

// Webhook routes are exercised without signatures in tests; signature verification has
// its own dedicated suite.
process.env.ALLOW_UNSIGNED_WEBHOOKS = 'true';
process.env.EMAIL_WEBHOOK_SECRET = 'test-email-secret';
process.env.WHATSAPP_WEBHOOK_SECRET = 'test-whatsapp-secret';

/**
 * After every test, the materialised charge status must still equal the derivation.
 *
 * Global rather than opt-in, and that is the whole point. `Transaction.documentationStatus`
 * is a cache maintained by seven write paths; an eighth added later will not come with its
 * own test asserting the cache stayed true, because whoever adds it will be thinking about
 * their feature. Running the check after *every* test means their change fails somebody
 * else's suite instead — which is the only place an invariant reliably gets noticed.
 *
 * It costs one indexed read per test against a table the suite keeps small.
 */
afterEach(async () => {
  const { expectStatusesConsistent, expectSlotAgreesWithMatches } = await import(
    './helpers/invariants'
  );
  const { testPrisma } = await import('./helpers/db');

  // Checked through the same client the fixtures are written with. The default client is
  // the one the route handlers use; reading the invariant through a second connection
  // made the check observe a different snapshot than the test had just committed.
  await expectStatusesConsistent(testPrisma);
  await expectSlotAgreesWithMatches(testPrisma);
});
