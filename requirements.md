# Darb Portal - Engineering Take-Home Exercise

This exercise is designed to evaluate candidates' engineering skills in real-world scenarios that match the work done at Darb.

It is designed to be completed in approximately **3 hours**.

---

## Getting Started

### Project Setup

Create a new Next.js project with our standard stack:

```bash
# Create Next.js app with TypeScript
npx create-next-app@latest darb-takehome --typescript --tailwind --eslint --app --src-dir=false

cd darb-takehome

# Install required dependencies
npm install @prisma/client zod next-safe-action date-fns lucide-react
npm install @radix-ui/react-slot class-variance-authority clsx tailwind-merge

# Install Shadcn UI
npx shadcn@latest init
npx shadcn@latest add button badge table tabs tooltip

# Install dev dependencies
npm install -D prisma jest ts-jest @types/jest

# Initialize Prisma
npx prisma init --datasource-provider sqlite
```

> SQLite is fine for this exercise — no need to run Postgres.

### Project Structure

```
darb-takehome/
├── app/
│   ├── api/
│   │   └── webhooks/
│   │       ├── email/route.ts       # Inbound email webhook
│   │       └── whatsapp/route.ts    # Inbound WhatsApp webhook
│   └── review/page.tsx              # Review queue (bonus)
├── lib/
│   ├── prisma.ts
│   ├── extraction/
│   │   ├── types.ts                 # DocumentExtractor interface
│   │   └── mock-extractor.ts        # Provided fixture-based mock
│   ├── services/
│   │   ├── document-ingestion.ts    # Webhook → Document pipeline
│   │   └── transaction-matcher.ts   # Matching engine
│   └── actions/
│       └── review.ts                # Confirm / reject match actions
├── prisma/
│   ├── schema.prisma
│   └── seed.ts                      # Provided-style seed data
├── fixtures/                        # Sample webhook payloads + extraction results
└── types/
```

### Required Boilerplate Files

Create these files before starting:

**`lib/prisma.ts`**
```typescript
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
```

**`lib/utils.ts`**
```typescript
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

**`lib/actions/safe-action-client.ts`**
```typescript
import { createSafeActionClient } from 'next-safe-action';

export const actionClient = createSafeActionClient();
```

**`lib/logger.ts`**
```typescript
export const log = {
  info: (message: string, meta?: Record<string, unknown>) => {
    console.log(`[INFO] ${message}`, meta || '');
  },
  error: (message: string, meta?: Record<string, unknown>) => {
    console.error(`[ERROR] ${message}`, meta || '');
  },
  warn: (message: string, meta?: Record<string, unknown>) => {
    console.warn(`[WARN] ${message}`, meta || '');
  },
};
```

**`jest.config.ts`**
```typescript
import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  testMatch: ['**/__tests__/**/*.test.ts'],
};

export default config;
```

---

## Exercise: Receipt & Invoice OCR Matching

### Background

Darb clients must attach a receipt or tax invoice to every card transaction for VAT compliance. In practice, drivers snap a photo and send it over **WhatsApp**, and suppliers email **invoices** to the fleet manager, who forwards them to a dedicated inbox. Today someone manually opens each document and hunts for the matching transaction. We want to automate that.

### Problem Statement

Build a **document ingestion and matching workflow** that:

1. Receives documents via **email** and **WhatsApp** webhooks,
2. Extracts structured data from them (OCR — mocked, see below),
3. **Matches** each document to an existing card transaction with a confidence score,
4. Auto-attaches high-confidence matches and routes ambiguous ones to a **review queue**.

You do **not** need to integrate a real OCR provider or a real email/WhatsApp service. Both are mocked; the engineering interest is in the pipeline and the matching engine.

### Stack Requirements

| Technology | Version | Purpose |
|------------|---------|---------|
| **TypeScript** | 5.x | Strict mode |
| **Next.js** | 15.x | App Router, Route Handlers for webhooks |
| **Prisma** | 6.x | Database ORM (SQLite) |
| **next-safe-action** | 8.x | Type-safe server actions |
| **Zod** | 3.x | Webhook payload + input validation |
| **Jest** | 29.x | Testing |

### Webhook Payloads (mock these senders)

**`POST /api/webhooks/email`** — simplified inbound-parse payload:

```json
{
  "messageId": "msg_8f2a1",
  "from": "billing@alfanar-fuel.com.sa",
  "to": "receipts@darb.example.com",
  "subject": "Tax Invoice #INV-99812",
  "receivedAt": "2025-06-14T09:21:00Z",
  "attachments": [
    {
      "filename": "invoice-99812.pdf",
      "contentType": "application/pdf",
      "contentBase64": "<base64>"
    }
  ]
}
```

**`POST /api/webhooks/whatsapp`** — simplified Meta Cloud API payload:

```json
{
  "entry": [{
    "changes": [{
      "value": {
        "messages": [{
          "id": "wamid.HBgMOTY2NT...",
          "from": "966551234567",
          "timestamp": "1718356881",
          "type": "image",
          "image": {
            "id": "media_4471",
            "mime_type": "image/jpeg",
            "sha256": "a3f1c9..."
          }
        }]
      }
    }]
  }]
}
```

For WhatsApp, resolve `image.id` to bytes through a `MediaStore` interface you define — back it with a simple in-repo fixture map (media id → file in `fixtures/`).

Webhook requirements:

- Validate payloads with Zod; malformed payloads → `400` with a useful body.
- **Idempotency**: both providers redeliver. The same `messageId` / message `id` — or the same file content (hash it) — must not create a duplicate `Document`.
- Webhooks must respond fast and never 500 because extraction or matching failed — a document that fails downstream should land in a `FAILED`/`UNMATCHED` state, not lose the webhook.
- The WhatsApp sender phone and email sender address are your keys for scoping which transactions a document may match (see schema below).

### OCR Extraction (provided interface — you write the mock)

**`lib/extraction/types.ts`**

```typescript
export interface ExtractedDocument {
  documentType: 'RECEIPT' | 'TAX_INVOICE' | 'UNKNOWN';
  merchantName: string | null;
  vatNumber: string | null;        // 15-digit KSA VAT number, when present
  totalAmount: number | null;      // minor units (halalas)
  currency: string | null;         // ISO 4217
  documentDate: string | null;     // ISO 8601
  cardLast4: string | null;
  invoiceNumber: string | null;
  rawText: string;
  extractionConfidence: number;    // 0..1, the OCR's own confidence
}

export interface DocumentExtractor {
  extract(file: Buffer, mimeType: string): Promise<ExtractedDocument>;
}
```

Implement `MockExtractor` returning deterministic fixtures keyed by file hash — commit at least **6 fixture documents** whose extraction results exercise your matcher (see edge cases). Keep the pipeline coded against the interface so a real provider could be swapped in.

### Prisma Schema

Seed data (write `prisma/seed.ts`) should include ~15 transactions across 2 clients and a driver-phone/email mapping. Suggested starting point — extend as you see fit:

```prisma
model Transaction {
  id             Int       @id @default(autoincrement())
  clientId       Int
  cardLast4      String
  driverPhone    String?   // E.164, used to scope WhatsApp documents
  merchantName   String    // acquirer-provided name, often noisy ("ALFANAR FUEL ST 04 RUH")
  amount         Int       // minor units
  currency       String    @default("SAR")
  transactionAt  DateTime
  documents      DocumentMatch[]
}

model Document {
  id               Int              @id @default(autoincrement())
  source           DocumentSource
  externalId       String           @unique   // messageId / wamid
  contentHash      String           @unique
  senderIdentifier String           // email address or phone
  status           DocumentStatus   @default(RECEIVED)
  // Extraction results (nullable until extracted)
  documentType     String?
  merchantName     String?
  vatNumber        String?
  totalAmount      Int?
  currency         String?
  documentDate     DateTime?
  cardLast4        String?
  rawText          String?
  receivedAt       DateTime         @default(now())
  matches          DocumentMatch[]
}

model DocumentMatch {
  id            Int          @id @default(autoincrement())
  documentId    Int
  transactionId Int
  document      Document     @relation(fields: [documentId], references: [id])
  transaction   Transaction  @relation(fields: [transactionId], references: [id])
  confidence    Float
  signals       Json         // per-signal score breakdown, for explainability
  status        MatchStatus  @default(CANDIDATE)
  decidedBy     String?      // 'system' | reviewer identifier
  decidedAt     DateTime?

  @@unique([documentId, transactionId])
}

enum DocumentSource { EMAIL WHATSAPP }
enum DocumentStatus { RECEIVED EXTRACTED MATCHED NEEDS_REVIEW UNMATCHED FAILED }
enum MatchStatus { CANDIDATE AUTO_CONFIRMED CONFIRMED REJECTED }
```

### The Matching Engine (the heart of the exercise)

**`lib/services/transaction-matcher.ts`**

```typescript
export interface MatchCandidate {
  transactionId: number;
  confidence: number;              // 0..1
  signals: Record<string, number>; // e.g. { amount: 1, date: 0.8, merchant: 0.6, cardLast4: 1 }
}

export interface MatchResult {
  outcome: 'AUTO_MATCHED' | 'NEEDS_REVIEW' | 'UNMATCHED';
  candidates: MatchCandidate[];    // ranked, best first
}

/** Pure function: no I/O — takes the document + candidate transactions. */
export function matchDocument(
  doc: ExtractedFields,
  transactions: CandidateTransaction[]
): MatchResult;
```

Design your own scoring, but it must use at least these signals, and the weights/thresholds must be **documented and justified** in `IMPLEMENTATION.md`:

- **Amount** — exact match vs. within a small tolerance (VAT rounding, tips at restaurants).
- **Date proximity** — receipt date vs. transaction date (same day, ±N days; documents can arrive days late).
- **Merchant name similarity** — fuzzy: acquirer names are abbreviated/uppercased ("ALFANAR FUEL ST 04 RUH" vs. "Alfanar Fuel Station"). Normalize + a string-similarity measure of your choice.
- **Card last4** — strong signal when the receipt shows it.
- **Sender scoping** — a WhatsApp document may only match transactions for that driver's cards; an email document only for that client.

Outcome rules:

- Single candidate above a high threshold → `AUTO_MATCHED` (create `AUTO_CONFIRMED` match, document → `MATCHED`).
- One or more mid-confidence candidates, **or two candidates with near-identical scores** → `NEEDS_REVIEW` (persist ranked candidates).
- Nothing plausible → `UNMATCHED`.
- A transaction that already has a `CONFIRMED`/`AUTO_CONFIRMED` document must not auto-match a second one — route to review instead (possible duplicate receipt).

Edge cases your fixtures + tests must cover:

1. Exact match — one obvious winner.
2. Two same-amount, same-day transactions at the same merchant chain (ambiguous → review).
3. Amount off by a tip/rounding (restaurant receipt 57.50 vs. transaction 63.25).
4. Duplicate submission — same photo sent twice via WhatsApp.
5. Invoice for a transaction that doesn't exist (yet) → `UNMATCHED`.
6. Extraction returned garbage (`documentType: 'UNKNOWN'`, null amount) → `FAILED`/`UNMATCHED`, never a crash.

### Server Actions (review queue)

**`lib/actions/review.ts`**

```typescript
export const confirmMatch = actionClient
  .schema(z.object({ matchId: z.number() }))
  .action(async ({ parsedInput }) => {
    // Confirm the candidate, reject sibling candidates, update document status
  });

export const rejectMatch = actionClient
  .schema(z.object({ matchId: z.number() }))
  .action(async ({ parsedInput }) => {
    // Reject; if no candidates remain, document → UNMATCHED
  });
```

Both must be safe against double-submits and enforce the one-confirmed-document-per-transaction rule at the data layer, not just in UI logic.

### Tests

- **Matcher unit tests** — it's a pure function; this is where most of your test effort should go. Cover every edge case above.
- **Ingestion tests** — webhook route or ingestion service: valid payload creates a document once; redelivery doesn't duplicate; extraction failure lands in a terminal state.
- Normalization/similarity helpers tested with real-world-messy merchant strings.

### Evaluation Criteria

| Criteria | Weight | Description |
|----------|--------|-------------|
| Matching engine | 30% | Sensible scoring, ambiguity handling, explainable signal breakdown |
| Pipeline architecture | 25% | Webhook idempotency, failure isolation, extractor behind an interface |
| Data modeling | 20% | Document/match lifecycle states, constraints that enforce the rules |
| Type safety | 15% | Strict types end-to-end, Zod at the boundaries, no `any` |
| Testing | 10% | Matcher edge cases, ingestion idempotency |

### Deliverables

1. `app/api/webhooks/email/route.ts` + `app/api/webhooks/whatsapp/route.ts`
2. `lib/services/document-ingestion.ts` — webhook → document pipeline
3. `lib/services/transaction-matcher.ts` — matching engine (pure)
4. `lib/extraction/` — extractor interface + mock with fixtures
5. `prisma/schema.prisma` + `prisma/seed.ts`
6. `lib/actions/review.ts` — confirm/reject server actions
7. Tests for matcher + ingestion
8. `IMPLEMENTATION.md` — scoring design, thresholds, assumptions, trade-offs

### Bonus Points

- A minimal `/review` page listing `NEEDS_REVIEW` documents with ranked candidates and confirm/reject buttons.
- Handle a document arriving **before** its transaction: re-run matching for `UNMATCHED` documents when new transactions are ingested.
- Multi-transaction invoice: one emailed statement covering several transactions (design sketch in `IMPLEMENTATION.md` is enough).
- Swap the mock for a real extractor behind the same interface (e.g. an LLM vision call) — keep the mock as the default so reviewers can run without keys.
- Webhook signature verification (HMAC) on both endpoints.

---

## General Guidelines

### What We're Looking For

1. **Judgment under ambiguity**: matching is probabilistic — we care how you handle the grey zone, not just the happy path.
2. **Code Quality**: clean, readable, well-organized code.
3. **Type Safety**: proper TypeScript usage, no `any` types.
4. **Error Handling**: webhooks and OCR fail constantly in production; the pipeline must degrade, not break.
5. **Documentation**: clear explanation of decisions and trade-offs.

### Submission

1. Create a GitHub repository (public or private with access granted).
2. Include a `README.md` with setup instructions, how to run the project (including seeding and firing the sample webhooks — a `curl` script or `.http` file is appreciated), and how to run tests.
3. Include `IMPLEMENTATION.md` explaining your approach and key decisions, any assumptions made, what you would improve with more time, and trade-offs you considered.
4. Share the repository link.

### Time Expectation

This exercise is designed for approximately **3 hours**. Focus on demonstrating your skills rather than building a complete production system. If you run out of time, cut the review UI and bonus items — not the matcher edge cases or webhook idempotency.

Good luck! We look forward to reviewing your submission.
