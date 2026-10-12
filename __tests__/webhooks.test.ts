import { POST as emailPost } from '@/app/api/webhooks/email/route';
import { POST as whatsappPost } from '@/app/api/webhooks/whatsapp/route';
import { readFixtureFile } from '@/fixtures';
import { allowUnsignedWebhooks, computeSignature } from '@/lib/webhooks/signature';
import { MockExtractor, setExtractor } from '@/lib/extraction';
import { resetDatabase, seedMinimalWorld, testPrisma } from './helpers/db';

/**
 * Webhook route tests.
 *
 * These assert the contract the brief states explicitly: malformed payloads are a 400
 * with a useful body, and nothing a downstream failure can do produces a 500.
 */

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const emailPayload = (overrides: Record<string, unknown> = {}) => ({
  messageId: 'msg_8f2a1',
  from: 'fleetops@rawabi-logistics.example',
  to: 'receipts@darb.example.com',
  subject: 'Tax Invoice #INV-99812',
  receivedAt: '2025-06-14T09:21:00Z',
  attachments: [
    {
      filename: 'invoice-99812.pdf',
      contentType: 'application/pdf',
      contentBase64: readFixtureFile('email-alfanar-invoice').toString('base64'),
    },
  ],
  ...overrides,
});

const whatsappPayload = (overrides: { wamid?: string; mediaId?: string; from?: string } = {}) => ({
  entry: [
    {
      changes: [
        {
          value: {
            messages: [
              {
                id: overrides.wamid ?? 'wamid.HBgMOTY2NTUxMjM0NTY3',
                from: overrides.from ?? '966551234567',
                timestamp: '1718356881',
                type: 'image',
                image: {
                  id: overrides.mediaId ?? 'media_4471',
                  mime_type: 'image/jpeg',
                  sha256: 'a3f1c9',
                },
              },
            ],
          },
        },
      ],
    },
  ],
});

beforeEach(async () => {
  setExtractor(new MockExtractor());
  await resetDatabase();
  await seedMinimalWorld();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

/* -------------------------------------------------------------------------- */

describe('email webhook', () => {
  it('accepts a valid payload and reports the match outcome', async () => {
    const response = await emailPost(post('http://localhost/api/webhooks/email', emailPayload()));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(body.documents[0]).toMatchObject({ disposition: 'INGESTED', status: 'MATCHED' });
  });

  it('returns 400 with field-level issues for a malformed payload', async () => {
    const response = await emailPost(
      post('http://localhost/api/webhooks/email', { messageId: '', from: 'not-an-email' }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.accepted).toBe(false);
    expect(body.issues.map((issue: { path: string }) => issue.path)).toEqual(
      expect.arrayContaining(['messageId', 'from', 'receivedAt', 'attachments']),
    );
  });

  it('returns 400 for a body that is not JSON', async () => {
    const response = await emailPost(post('http://localhost/api/webhooks/email', '{not json'));

    expect(response.status).toBe(400);
  });

  it('is idempotent across redelivery', async () => {
    await emailPost(post('http://localhost/api/webhooks/email', emailPayload()));
    const second = await emailPost(post('http://localhost/api/webhooks/email', emailPayload()));
    const body = await second.json();

    expect(second.status).toBe(200);
    expect(body.documents[0].disposition).toBe('DUPLICATE');
    expect(await testPrisma.document.count()).toBe(1);
  });

  it('gives each attachment of a multi-attachment email its own document', async () => {
    const payload = emailPayload({
      attachments: [
        {
          filename: 'invoice-99812.pdf',
          contentType: 'application/pdf',
          contentBase64: readFixtureFile('email-alfanar-invoice').toString('base64'),
        },
        {
          filename: 'jarir.pdf',
          contentType: 'application/pdf',
          contentBase64: readFixtureFile('email-jarir-lowconfidence').toString('base64'),
        },
      ],
    });

    const response = await emailPost(post('http://localhost/api/webhooks/email', payload));
    const body = await response.json();

    expect(body.documents).toHaveLength(2);
    expect(await testPrisma.document.count()).toBe(2);
  });
});

describe('whatsapp webhook', () => {
  it('resolves media through the MediaStore and ingests it', async () => {
    const response = await whatsappPost(
      post('http://localhost/api/webhooks/whatsapp', whatsappPayload()),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages[0]).toMatchObject({ disposition: 'INGESTED', status: 'MATCHED' });
  });

  it('returns 400 when type says image but no image object is present', async () => {
    const malformed = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { id: 'wamid.X', from: '966551234567', timestamp: '1718356881', type: 'image' },
                ],
              },
            },
          ],
        },
      ],
    };

    const response = await whatsappPost(post('http://localhost/api/webhooks/whatsapp', malformed));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.issues.some((issue: { path: string }) => issue.path.endsWith('image'))).toBe(true);
  });

  it.each([
    ['non-numeric', 'not-a-number'],
    ['empty-ish whitespace', ' '],
    ['too large to be a date', '99999999999999'],
  ])('returns 400 for a %s timestamp, naming the field', async (_label, timestamp) => {
    // An unparseable timestamp used to pass validation and fail at the database write
    // instead, which returned an opaque 200 "accepted but not processed". The sender
    // learns nothing from that; a 400 naming the field is something they can act on, and
    // it is what the brief asks for a malformed payload.
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.BADTS',
                    from: '966551234567',
                    timestamp,
                    type: 'image',
                    image: { id: 'media_4471', mime_type: 'image/jpeg' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const response = await whatsappPost(post('http://localhost/api/webhooks/whatsapp', payload));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(
      body.issues.some((issue: { path: string }) => issue.path.endsWith('timestamp')),
    ).toBe(true);
  });

  it('acknowledges a status-only callback without creating anything', async () => {
    const response = await whatsappPost(
      post('http://localhost/api/webhooks/whatsapp', {
        entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.X', status: 'delivered' }] } }] }],
      }),
    );

    expect(response.status).toBe(200);
    expect(await testPrisma.document.count()).toBe(0);
  });

  it('skips an unresolvable media id with 200 rather than failing the batch', async () => {
    const response = await whatsappPost(
      post('http://localhost/api/webhooks/whatsapp', whatsappPayload({ mediaId: 'media_nope' })),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages[0].disposition).toBe('FAILED');
    expect(await testPrisma.document.count()).toBe(0);
  });

  it('ignores a text message that carries no document', async () => {
    const response = await whatsappPost(
      post('http://localhost/api/webhooks/whatsapp', {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: 'wamid.TEXT',
                      from: '966551234567',
                      timestamp: '1718356881',
                      type: 'text',
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(await testPrisma.document.count()).toBe(0);
  });

  it('is idempotent across redelivery of the same wamid', async () => {
    await whatsappPost(post('http://localhost/api/webhooks/whatsapp', whatsappPayload()));
    const second = await whatsappPost(
      post('http://localhost/api/webhooks/whatsapp', whatsappPayload()),
    );
    const body = await second.json();

    expect(body.messages[0].disposition).toBe('DUPLICATE');
    expect(await testPrisma.document.count()).toBe(1);
  });
});

describe('signature verification', () => {
  const payload = whatsappPayload({ wamid: 'wamid.SIGNED' });
  const raw = JSON.stringify(payload);

  it('accepts a correctly signed request when unsigned requests are disallowed', async () => {
    process.env.ALLOW_UNSIGNED_WEBHOOKS = 'false';
    try {
      const response = await whatsappPost(
        post('http://localhost/api/webhooks/whatsapp', raw, {
          'x-hub-signature-256': computeSignature(raw, 'test-whatsapp-secret'),
        }),
      );
      expect(response.status).toBe(200);
    } finally {
      process.env.ALLOW_UNSIGNED_WEBHOOKS = 'true';
    }
  });

  it('rejects a request with no signature when unsigned requests are disallowed', async () => {
    process.env.ALLOW_UNSIGNED_WEBHOOKS = 'false';
    try {
      const response = await whatsappPost(post('http://localhost/api/webhooks/whatsapp', raw));
      expect(response.status).toBe(401);
    } finally {
      process.env.ALLOW_UNSIGNED_WEBHOOKS = 'true';
    }
  });

  it('rejects a wrong signature even when unsigned requests are allowed', async () => {
    // Permissiveness must never extend to accepting a forgery.
    const response = await whatsappPost(
      post('http://localhost/api/webhooks/whatsapp', raw, {
        'x-hub-signature-256': computeSignature(raw, 'the-wrong-secret'),
      }),
    );

    expect(response.status).toBe(401);
  });

  it('rejects a signature computed over different bytes', async () => {
    const response = await emailPost(
      post('http://localhost/api/webhooks/email', emailPayload(), {
        'x-darb-signature': computeSignature('{"tampered":true}', 'test-email-secret'),
      }),
    );

    expect(response.status).toBe(401);
  });
});

describe('unsigned-request policy', () => {
  const original = { nodeEnv: process.env.NODE_ENV, allow: process.env.ALLOW_UNSIGNED_WEBHOOKS };

  afterEach(() => {
    // NODE_ENV is readonly in the Next types but writable at runtime; restore it so the
    // rest of the suite is unaffected.
    Object.defineProperty(process.env, 'NODE_ENV', { value: original.nodeEnv, configurable: true });
    if (original.allow === undefined) delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
    else process.env.ALLOW_UNSIGNED_WEBHOOKS = original.allow;
  });

  it('refuses unsigned requests in production even when the flag says otherwise', () => {
    // The failure this guards: a production deploy that forgets the variable. Defaulting
    // to open there means accepting forged webhooks from anyone who knows the URL.
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true });
    process.env.ALLOW_UNSIGNED_WEBHOOKS = 'true';

    expect(allowUnsignedWebhooks()).toBe(false);
  });

  it('allows unsigned requests outside production so the sample scripts run', () => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'development', configurable: true });
    delete process.env.ALLOW_UNSIGNED_WEBHOOKS;

    expect(allowUnsignedWebhooks()).toBe(true);
  });

  it('still honours an explicit opt-out outside production', () => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'development', configurable: true });
    process.env.ALLOW_UNSIGNED_WEBHOOKS = 'false';

    expect(allowUnsignedWebhooks()).toBe(false);
  });
});
