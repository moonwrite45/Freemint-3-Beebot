export function shortenAddress(address: string, head = 6, tail = 4): string {
  if (address.length <= head + tail + 2) return address;
  return `${address.slice(0, head)}...${address.slice(-tail)}`;
}

/**
 * Escapes the characters that would otherwise break Telegram's HTML
 * parse_mode. Needed on every piece of dynamic text placed in a message
 * that also uses codeSpan() elsewhere in the same message — parse_mode
 * applies to the whole message, not just the span you intended to format.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Wraps text in Telegram's <code> tag — renders monospace, and on mobile
 * Telegram clients tapping it copies the full text to the clipboard.
 * This is what actually makes an address "press to copy": there's no
 * separate copy button, it's this formatting plus Telegram's own client
 * behavior. Any message using this needs { parse_mode: "HTML" }.
 */
export function codeSpan(text: string): string {
  return `<code>${escapeHtml(text)}</code>`;
}
