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
