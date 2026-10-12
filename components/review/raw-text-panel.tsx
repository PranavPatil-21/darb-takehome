
import { t } from '@/lib/content/messages';
/**
 * What was actually sent.
 *
 * The OCR text is persisted on every document and, until now, displayed nowhere — so a
 * reviewer was asked to judge a receipt they could not see, from four fields someone
 * else's software extracted from it. This is the closest thing to showing them the paper
 * that exists without blob storage, and it costs a column read.
 *
 * It earns its place on the hardest cases rather than the easy ones: when two charges tie
 * and the extracted fields are identical by construction, the only remaining evidence is
 * whatever else is printed on the receipt — a branch name, a till number, a time.
 *
 * `dir="auto"` because Saudi receipts are routinely bilingual, and a right-to-left block
 * rendered left-to-right is unreadable to the person most likely to need it.
 */
export function RawTextPanel({ text, source }: { text: string | null; source: string }) {
  if (!text || text.trim() === '') return null;

  const heading = t(source === 'EMAIL' ? 'review.rawText.email' : 'review.rawText.whatsapp');

  return (
    <section className="mt-5">
      <h3 className="text-xs font-medium text-muted-foreground">{heading}</h3>
      <pre
        dir="auto"
        className="mt-1.5 max-h-56 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words"
      >
        {text}
      </pre>
    </section>
  );
}
