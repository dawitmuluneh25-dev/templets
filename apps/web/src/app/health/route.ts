import { NextResponse } from 'next/server';

import { getLibrary } from '@/lib/corpus';

/**
 * Liveness for the platform, with the one fact that matters: the library loaded.
 *
 * A process that answers 200 with zero templates is worse than one that fails its
 * probe, because the failure then surfaces as "the templates are missing" from a
 * clinician rather than from a page.
 *
 * The reason is a code, not the error message: the message contains a filesystem path
 * and this endpoint is reachable without authentication.
 */
export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  try {
    const library = getLibrary();

    return NextResponse.json(
      { status: 'ok', templates: library.templates.length },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json(
      { status: 'error', reason: 'library_unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
