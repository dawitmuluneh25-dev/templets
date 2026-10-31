import { TOKEN_SCHEMA_VERSION } from './types.js';
import type { TokenDocument } from './types.js';

/**
 * Brings a stored document to the current schema version, or refuses.
 *
 * Total by design: it returns a current document or throws. There is no third
 * outcome where a caller gets something that is *probably* fine — that is how a
 * signed report ends up rendered by code that does not understand it.
 *
 * Version 1 is the first version, so today this is an assertion. It exists now
 * so that the first real migration has somewhere to live and a signature to
 * keep honest.
 */
export function migrate(document: TokenDocument): TokenDocument {
  if (document.schema_version === TOKEN_SCHEMA_VERSION) {
    return document;
  }

  throw new Error(
    `Unsupported token schema version ${String(document.schema_version)}; ` +
      `this build understands ${TOKEN_SCHEMA_VERSION}.`,
  );
}
