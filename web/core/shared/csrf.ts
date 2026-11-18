/** The cookie-auth CSRF header. Bearer clients do not need it. */

export const CSRF_HEADER = "x-pi-web-csrf";
export const CSRF_HEADER_VALUE = "1";

/** Apply the header to a browser request when the server opt-in is enabled. */
export function csrfHeaders(): Record<string, string> {
  return { [CSRF_HEADER]: CSRF_HEADER_VALUE };
}
