/**
 * Deep module for converting T:ss timestamps in text to clickable HTML anchor links.
 * Also converts basic Markdown (bold, italic) to HTML before escaping plain text.
 * Pure transformation: text to HTML with timestamp pills.
 */

const PILL_CLASSES = 'inline-flex items-center bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded text-sm font-medium hover:bg-indigo-200 transition-colors';

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': String.fromCharCode(38) + 'amp;',
    '<': String.fromCharCode(38) + 'lt;',
    '>': String.fromCharCode(38) + 'gt;',
    '"': String.fromCharCode(38) + 'quot;',
    "'": String.fromCharCode(38) + '#39;',
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Converts basic Markdown syntax to HTML tags.
 * Handles **bold** and *italic* (greedy, requires content between markers).
 */
function markdownToHtml(text: string): string {
  // Bold: **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>');
  text = text.replace(/__(.+?)__/gs, '<strong>$1</strong>');
  // Italic: *text* or _text_ (after bold to avoid conflicts)
  text = text.replace(/\*(.+?)\*/gs, '<em>$1</em>');
  text = text.replace(/_(.+?)_/gs, '<em>$1</em>');
  return text;
}

/**
 * Processes text: converts Markdown to HTML, escapes remaining plain text,
 * then injects timestamp anchor pills.
 */
function processText(text: string): string {
  // Step 1: Extract and protect Markdown tags by replacing with placeholders
  const markdownParts: string[] = [];
  let idx = 0;

  // Protect **bold**, __bold__, *italic*, and _italic_ patterns by extracting them
  text = text.replace(/(\*\*.+?\*\*)|(__.+?__)|(\*.+?\*)|(_.+?_)/gs, (match) => {
    const placeholder = `\x00MD${idx++}\x00`;
    markdownParts.push(match);
    return placeholder;
  });

  // Step 2: Escape the remaining plain text
  text = escapeHtml(text);

  // Step 3: Restore Markdown patterns and convert to HTML
  text = text.replace(/\x00MD(\d+)\x00/g, (_match, i) => {
    return markdownToHtml(markdownParts[parseInt(i, 10)]);
  });

  return text;
}

export interface TimestampFormatter {
  /**
   * Convert T:ss timestamps in text to clickable [MM:SS] anchor links.
   * Also converts basic Markdown (bold, italic) to HTML.
   */
  format(text: string): string;
}

export class TimestampFormatterImpl implements TimestampFormatter {
  format(text: string): string {
    // Process markdown + escape plain text
    const processed = processText(text);
    // Convert timestamps to clickable anchor pills
    return processed.replace(/(?:\[)?(T:(\d+))(?:\])?/g, (_match, _ref, seconds) => {
      const ms = parseInt(seconds, 10) * 1000;
      const label = formatTime(ms);
      return `<a href="#t-${ms}" rel="nofollow noreferrer" class="${PILL_CLASSES}" data-timestamp="${ms}">[${label}]</a>`;
    });
  }
}

/** Convenience singleton for direct import usage. */
export const TimestampFormatter = new TimestampFormatterImpl();