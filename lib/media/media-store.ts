import { FIXTURES_BY_SLUG, readFixtureFile } from '@/fixtures';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WhatsApp webhooks carry a media *id*, not bytes. In production you exchange that id
 * for a short-lived URL on the Graph API and then download it; here that round trip sits
 * behind this interface so the pipeline code is identical either way.
 */
export interface MediaStore {
  /** Returns the file bytes, or null when the id is unknown to the provider. */
  fetch(mediaId: string): Promise<MediaObject | null>;
}

export interface MediaObject {
  bytes: Buffer;
  mimeType: string;
  filename: string;
}

/** Thrown when the media service is reachable but failing — distinct from "not found". */
export class MediaUnavailableError extends Error {
  constructor(mediaId: string, cause?: unknown) {
    super(`Media ${mediaId} could not be retrieved`);
    this.name = 'MediaUnavailableError';
    this.cause = cause;
  }
}

/** media id -> fixture slug. The in-repo stand-in for Meta's media service. */
const MEDIA_MAP: Readonly<Record<string, string>> = {
  media_4471: 'whatsapp-alfanar-exact',
  media_4472: 'whatsapp-tamimi-ambiguous',
  media_4473: 'whatsapp-najd-tip',
  media_4474: 'whatsapp-orphan-receipt',
  media_4475: 'whatsapp-blurry-garbage',
  media_4476: 'whatsapp-petromin-generic',
};

export class FixtureMediaStore implements MediaStore {
  async fetch(mediaId: string): Promise<MediaObject | null> {
    const slug = MEDIA_MAP[mediaId];
    if (!slug) return null;

    const fixture = FIXTURES_BY_SLUG.get(slug);
    if (!fixture) return null;

    return {
      bytes: readFixtureFile(slug),
      mimeType: fixture.mimeType,
      filename: fixture.filename,
    };
  }
}

/** Resolves an email attachment slug for the sample payloads. */
export function readEmailFixture(slug: string): Buffer {
  return readFileSync(join(process.cwd(), 'fixtures', 'documents', `${slug}.txt`));
}

let mediaStore: MediaStore = new FixtureMediaStore();

export function getMediaStore(): MediaStore {
  return mediaStore;
}

/** Test seam, mirroring `setExtractor`. */
export function setMediaStore(next: MediaStore): void {
  mediaStore = next;
}

export { MEDIA_MAP };
