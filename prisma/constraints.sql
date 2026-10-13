-- Constraints Prisma's schema language cannot express.
--
-- Applied by `scripts/apply-constraints.mjs` immediately after `prisma db push`, because
-- `db push` works from `schema.prisma` and would otherwise leave them out.

-- One confirmed document per charge.
--
-- `Transaction.confirmedDocumentId` is scalar and uniquely indexed, which gives "a charge
-- points at one document" and "a document is evidence for one charge". Neither constrains
-- the thing the rest of the system reads as the truth: `DocumentMatch.status`. Nothing
-- stopped two CONFIRMED rows naming one charge, and agreement between the fact and its
-- mirror was maintained only by compare-and-set across four call sites in application
-- code.
--
-- That failed. A lost race in `overturnAttachment` released the slot while the match still
-- read CONFIRMED, a second document claimed the freed slot, and one charge ended up
-- holding two confirmed documents — through a green test suite. The brief asks for this
-- rule "at the data layer, not just in UI logic"; this is that.
--
-- Partial on purpose. A plain unique index on `transactionId` would forbid a charge from
-- ever having two *candidates*, which is exactly what the review queue is for. SQLite and
-- Postgres both support the `WHERE` form.
CREATE UNIQUE INDEX IF NOT EXISTS "DocumentMatch_one_confirmed_per_transaction"
  ON "DocumentMatch" ("transactionId")
  WHERE "status" IN ('CONFIRMED', 'AUTO_CONFIRMED');
