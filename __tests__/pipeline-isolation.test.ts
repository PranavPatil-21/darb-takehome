import { POST as emailPost } from '@/app/api/webhooks/email/route';
import { POST as whatsappPost } from '@/app/api/webhooks/whatsapp/route';
import { readFixtureFile } from '@/fixtures';
import { MockExtractor, setExtractor } from '@/lib/extraction';
import { MediaUnavailableError, setMediaStore, FixtureMediaStore } from '@/lib/media/media-store';
import type { MediaStore, MediaObject } from '@/lib/media/media-store';
import { resetDatabase, seedMinimalWorld, testPrisma } from './helpers/db';
import prisma from '@/lib/prisma';

/**
 * Per-item failure isolation in the webhook routes.
 *
 * Both routes wrapped their whole loop in one try. A single failing item therefore
 * aborted every item after it, discarded the results already accumulated, and still
 * answered 200 — so the provider never redelivered and those documents were lost with no
 * record. These tests pin the corrected contract: one bad item costs exactly itself.
 */

const post = (url: string, body: unknown) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const attachment = (slug: string, filename: string) => ({
  filename,
  contentType: 'application/pdf',
  contentBase64: readFixtureFile(slug).toString('base64'),
});

beforeEach(async () => {
  setExtractor(new MockExtractor());
  setMediaStore(new FixtureMediaStore());
  await resetDatabase();
  await seedMinimalWorld();
});

afterEach(() => {
  jest.restoreAllMocks();
  setMediaStore(new FixtureMediaStore());
});

/* ========================================================================== */
/* B2 — one failing item must not cost the others                             */
/* ========================================================================== */

describe('email webhook per-attachment isolation', () => {
  test('ingests the surviving attachments when one hits an infrastructure failure', async () => {
    // The failure that escapes `ingestDocument` is not a bad document — extraction
    // failures are already caught and parked as FAILED. It is the store itself giving
    // out: a dropped connection, a constraint that is not the idempotency one. That is
    // the error the route must survive, so it is the error this test injects.
    const realCreate = prisma.document.create.bind(prisma.document);
    let attempts = 0;
    jest.spyOn(prisma.document, 'create').mockImplementation(((args: unknown) => {
      attempts += 1;
      if (attempts === 2) return Promise.reject(new Error('connection reset by peer'));
      return realCreate(args as never);
    }) as never);

    const response = await emailPost(
      post('http://localhost/api/webhooks/email', {
        messageId: 'msg_isolation',
        from: 'fleetops@rawabi-logistics.example',
        to: 'receipts@darb.example.com',
        subject: 'Three invoices',
        receivedAt: '2025-06-14T09:21:00Z',
        attachments: [
          attachment('email-alfanar-invoice', 'one.pdf'),
          attachment('whatsapp-alfanar-exact', 'two.pdf'),
          attachment('whatsapp-najd-tip', 'three.pdf'),
        ],
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();

    // All three reported, not just the one before the failure — and crucially the
    // results accumulated so far are not discarded.
    expect(body.documents).toHaveLength(3);
    expect(body.documents[1]!.disposition).toBe('FAILED');
    // The two healthy attachments were still stored.
    expect(await testPrisma.document.count()).toBe(2);
  });

  test('parks an attachment whose extraction dies without losing the others', async () => {
    setExtractor({
      async extract() {
        throw new Error('every extraction fails');
      },
    });

    const response = await emailPost(
      post('http://localhost/api/webhooks/email', {
        messageId: 'msg_allfail',
        from: 'fleetops@rawabi-logistics.example',
        to: 'receipts@darb.example.com',
        subject: 'Two invoices',
        receivedAt: '2025-06-14T09:21:00Z',
        attachments: [
          attachment('email-alfanar-invoice', 'one.pdf'),
          attachment('whatsapp-alfanar-exact', 'two.pdf'),
        ],
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.documents).toHaveLength(2);
    expect(body.documents.every((d: { status: string }) => d.status === 'FAILED')).toBe(true);
  });

  test('a valid payload whose attachments are all undecodable is accepted, not rejected', async () => {
    // The payload passed Zod. Telling a conforming provider its request was malformed is
    // a lie, and some providers escalate 4xx differently from 2xx.
    const response = await emailPost(
      post('http://localhost/api/webhooks/email', {
        messageId: 'msg_empty',
        from: 'fleetops@rawabi-logistics.example',
        to: 'receipts@darb.example.com',
        subject: 'Nothing usable',
        receivedAt: '2025-06-14T09:21:00Z',
        // Non-empty, so it passes Zod, but Buffer.from skips every invalid character
        // and yields zero bytes. An empty string would be a genuinely malformed payload
        // and is correctly a 400.
        attachments: [{ filename: 'x.pdf', contentType: 'application/pdf', contentBase64: '!' }],
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0]!.disposition).toBe('SKIPPED');
  });
});

describe('whatsapp webhook per-message isolation', () => {
  test('ingests the surviving messages when one media fetch dies', async () => {
    setMediaStore({
      async fetch(mediaId: string): Promise<MediaObject | null> {
        if (mediaId === 'media_4472') throw new MediaUnavailableError(mediaId);
        return new FixtureMediaStore().fetch(mediaId);
      },
    } satisfies MediaStore);

    const message = (wamid: string, mediaId: string) => ({
      id: wamid,
      from: '966551234567',
      timestamp: '1718356881',
      type: 'image',
      image: { id: mediaId, mime_type: 'image/jpeg', sha256: 'a3f1c9' },
    });

    const response = await whatsappPost(
      post('http://localhost/api/webhooks/whatsapp', {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    message('wamid.one', 'media_4471'),
                    message('wamid.two', 'media_4472'),
                    message('wamid.three', 'media_4473'),
                  ],
                },
              },
            ],
          },
        ],
      }),
    );

    // 503, not 200: a 2xx tells Meta the batch was delivered and it will never resend.
    // There are no bytes, so there is no content hash and no Document to park in FAILED —
    // the only way not to lose that receipt is to be asked again. Redelivering the whole
    // batch is safe because the two that succeeded dedupe on wamid and content hash.
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.messages).toHaveLength(3);
    // The two good ones were still ingested despite the failure sitting between them.
    expect(await testPrisma.document.count()).toBe(2);
  });

  test('a transient media failure is reported distinctly from an unknown media id', async () => {
    setMediaStore({
      async fetch(mediaId: string): Promise<MediaObject | null> {
        if (mediaId === 'media_4471') throw new MediaUnavailableError(mediaId);
        return null;
      },
    } satisfies MediaStore);

    const message = (wamid: string, mediaId: string) => ({
      id: wamid,
      from: '966551234567',
      timestamp: '1718356881',
      type: 'image',
      image: { id: mediaId, mime_type: 'image/jpeg', sha256: 'a3f1c9' },
    });

    const response = await whatsappPost(
      post('http://localhost/api/webhooks/whatsapp', {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [message('wamid.transient', 'media_4471'), message('wamid.unknown', 'media_9999')],
                },
              },
            ],
          },
        ],
      }),
    );

    const body = await response.json();
    const byWamid = Object.fromEntries(
      body.messages.map((m: { wamid: string; disposition: string }) => [m.wamid, m.disposition]),
    );

    // Transient: we could not read it, and should be asked again.
    expect(byWamid['wamid.transient']).toBe('RETRYABLE');
    // Permanent: there is no such media, retrying forever helps nobody.
    expect(byWamid['wamid.unknown']).toBe('SKIPPED');
    // And the disposition has to reach the provider as a status code, or it is a note to
    // nobody: the retryable message is what makes this response a 503.
    expect(response.status).toBe(503);
  });
});
