/**
 * Regenerates `fixtures/payloads/*.json` from the fixture documents.
 *
 * Email payloads embed base64 of the real fixture bytes, so the hash the extractor
 * computes on the server matches the fixture catalogue. Generating rather than
 * hand-writing them is what keeps that true after any fixture edit.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_BY_SLUG, readFixtureFile } from '../fixtures';

const OUT = join(process.cwd(), 'fixtures', 'payloads');
mkdirSync(OUT, { recursive: true });

const write = (name: string, body: unknown) => {
  writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
  console.log(`wrote fixtures/payloads/${name}.json`);
};

const emailPayload = (options: {
  messageId: string;
  from: string;
  subject: string;
  receivedAt: string;
  slug: string;
}) => {
  const fixture = FIXTURES_BY_SLUG.get(options.slug)!;
  return {
    messageId: options.messageId,
    from: options.from,
    to: 'receipts@darb.example.com',
    subject: options.subject,
    receivedAt: options.receivedAt,
    attachments: [
      {
        filename: fixture.filename,
        contentType: fixture.mimeType,
        contentBase64: readFixtureFile(options.slug).toString('base64'),
      },
    ],
  };
};

const whatsappPayload = (options: {
  wamid: string;
  from: string;
  timestamp: string;
  mediaId: string;
  mimeType: string;
}) => ({
  entry: [
    {
      changes: [
        {
          value: {
            messages: [
              {
                id: options.wamid,
                from: options.from,
                timestamp: options.timestamp,
                type: 'image',
                image: { id: options.mediaId, mime_type: options.mimeType, sha256: 'a3f1c9' },
              },
            ],
          },
        },
      ],
    },
  ],
});

/* --- WhatsApp ----------------------------------------------------------- */

write(
  'whatsapp-01-exact-match',
  whatsappPayload({
    wamid: 'wamid.HBgMOTY2NTUxMjM0NTY3AA==',
    from: '966551234567',
    timestamp: '1749899520',
    mediaId: 'media_4471',
    mimeType: 'image/jpeg',
  }),
);

write(
  'whatsapp-02-ambiguous',
  whatsappPayload({
    wamid: 'wamid.HBgMOTY2NTUxMjM0NTY4AA==',
    from: '966551234567',
    timestamp: '1750162200',
    mediaId: 'media_4472',
    mimeType: 'image/jpeg',
  }),
);

write(
  'whatsapp-03-tip-mismatch',
  whatsappPayload({
    wamid: 'wamid.HBgMOTY2NTUxMjM0NTY5AA==',
    from: '966551234567',
    timestamp: '1749756600',
    mediaId: 'media_4473',
    mimeType: 'image/jpeg',
  }),
);

write(
  'whatsapp-04-orphan',
  whatsappPayload({
    wamid: 'wamid.HBgMOTY2NTUxMjM0NTcwAA==',
    from: '966551234567',
    timestamp: '1750338720',
    mediaId: 'media_4474',
    mimeType: 'image/jpeg',
  }),
);

write(
  'whatsapp-05-garbage',
  whatsappPayload({
    wamid: 'wamid.HBgMOTY2NTUxMjM0NTcxAA==',
    from: '966551234567',
    timestamp: '1750338999',
    mediaId: 'media_4475',
    mimeType: 'image/jpeg',
  }),
);

write(
  'whatsapp-06-generic-merchant',
  whatsappPayload({
    wamid: 'wamid.HBgMOTY2NTUxMjM0NTcyAA==',
    from: '966551234567',
    timestamp: '1750059000',
    mediaId: 'media_4476',
    mimeType: 'image/jpeg',
  }),
);

write(
  'whatsapp-07-wrong-client',
  // Same driver number as a Nujood driver, same photo as the Alfanar receipt. Proves the
  // document cannot reach Rawabi's identical transaction.
  whatsappPayload({
    wamid: 'wamid.HBgMOTY2NTYxMTEyMjMzAA==',
    from: '966561112233',
    timestamp: '1749899520',
    mediaId: 'media_4471',
    mimeType: 'image/jpeg',
  }),
);

/* --- Email -------------------------------------------------------------- */

write(
  'email-01-tax-invoice',
  emailPayload({
    messageId: 'msg_8f2a1',
    from: 'billing@alfanar-fuel.com.sa',
    subject: 'Tax Invoice #INV-99812',
    receivedAt: '2025-06-14T09:21:00Z',
    slug: 'email-alfanar-invoice',
  }),
);

write(
  'email-02-low-confidence',
  emailPayload({
    messageId: 'msg_8f2a2',
    from: 'fleetops@rawabi-logistics.example',
    subject: 'Fwd: Jarir invoice',
    receivedAt: '2025-06-06T08:00:00Z',
    slug: 'email-jarir-lowconfidence',
  }),
);

write(
  'email-03-unknown-sender',
  emailPayload({
    messageId: 'msg_8f2a3',
    from: 'someone@not-a-customer.example',
    subject: 'Invoice',
    receivedAt: '2025-06-14T10:00:00Z',
    slug: 'email-alfanar-invoice',
  }),
);
