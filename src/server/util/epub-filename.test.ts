import { describe, it, expect } from 'vitest';
import { sanitizeFilenameStem, epubFilename, contentDispositionAttachment } from './epub-filename.js';

// The filename half of the companion-EPUB download proxy (issue #146, AC17-AC20). Pure and total:
// every JavaScript string - lone surrogates included - must yield a header-safe name, because
// AC13's "header construction can never throw" is proved here, not at the route.
// #148 (send-to-Kindle) reuses these exact functions for its attachment name.
//
// Every non-ASCII input is written as a \uXXXX escape on purpose: the interesting cases are
// control characters and lone surrogates, which do not survive a copy/paste round trip.

/** True when the string contains a surrogate code unit with no partner - the `URIError` hazard. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe('sanitizeFilenameStem - the total stem function (AC18)', () => {
  it('passes an ordinary title through unchanged', () => {
    expect(sanitizeFilenameStem('The Hobbit')).toBe('The Hobbit');
  });

  it('appends NO suffix - adding it is AC19 step 4, and it happens exactly once', () => {
    expect(sanitizeFilenameStem('The Hobbit')).not.toMatch(/\.epub$/i);
  });

  it('strips the reserved set " \\ / : * ? < > | and every path separator', () => {
    expect(sanitizeFilenameStem('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij');
  });

  it('normalizes internal tabs/CR/LF to spaces and collapses the run (AC18 steps 2+5, F26)', () => {
    // Order matters: stripping controls FIRST would delete the tab/CR/LF outright and yield "AB".
    expect(sanitizeFilenameStem('A\t \r\nB')).toBe('A B');
  });

  it('drops the remaining control characters once whitespace has been normalized (AC18 step 3)', () => {
    expect(sanitizeFilenameStem('A\u0007B\u0000C\u007FD')).toBe('ABCD');
  });

  it('normalizes non-ASCII Unicode whitespace too (NBSP, NEL, ideographic space)', () => {
    // `\p{White_Space}` covers U+0085 (NEL), which the JS `\s` character class does not.
    expect(sanitizeFilenameStem('A\u00a0B\u0085C\u3000D')).toBe('A B C D');
  });

  it('trims leading/trailing spaces and dots (AC18 step 6)', () => {
    expect(sanitizeFilenameStem('  ..A Title.. ')).toBe('A Title');
  });

  it('truncates to at most 100 code points (AC18 step 7)', () => {
    expect(Array.from(sanitizeFilenameStem('x'.repeat(250)))).toHaveLength(100);
  });

  it('keeps an astral character that lands EXACTLY at the 100th code point (AC18 step 7, F30)', () => {
    // 99 ASCII + one emoji === exactly 100 code points, so nothing may be dropped. A
    // `String.slice(0, 100)` implementation would cut the surrogate pair in half here.
    const stem = sanitizeFilenameStem('a'.repeat(99) + '\u{1F600}');
    expect(Array.from(stem)).toHaveLength(100);
    expect(stem.endsWith('\u{1F600}')).toBe(true);
    expect(hasLoneSurrogate(stem)).toBe(false);
  });

  it('truncates BY CODE POINT: a pair straddling the bound is kept whole, never halved (F30)', () => {
    // 99 ASCII + emoji + more text. Correct truncation keeps the emoji (it is code point 100);
    // a code-UNIT `slice(0, 100)` keeps only its high surrogate and emits a lone surrogate that
    // would then throw URIError in the header encoder.
    const stem = sanitizeFilenameStem('a'.repeat(99) + '\u{1F600}' + 'b'.repeat(10));
    expect(hasLoneSurrogate(stem)).toBe(false);
    expect(stem).toBe('a'.repeat(99) + '\u{1F600}');
  });

  it('drops the 101st code point and leaves no half surrogate behind (AC18 step 7, F30)', () => {
    const stem = sanitizeFilenameStem('a'.repeat(100) + '\u{1F600}');
    expect(stem).toBe('a'.repeat(100));
    expect(hasLoneSurrogate(stem)).toBe(false);
  });

  it('re-trims spaces/dots that truncation exposes at the boundary (AC18 step 8, F31)', () => {
    // The first 100 code points end in " ." - an implementation that trims only BEFORE
    // truncating keeps them and fails here while passing every other case.
    expect(sanitizeFilenameStem('a'.repeat(98) + ' .' + 'B'.repeat(20))).toBe('a'.repeat(98));
  });

  it('removes an unpaired HIGH surrogate that was already present in the input (AC18 step 1)', () => {
    // #148 hands this helper ordinary strings, not URL-decoded ones, so a lone surrogate can
    // genuinely arrive. `Array.from(...).join('')` preserves it - and `encodeURIComponent`
    // then throws URIError, which is the failure AC13 says can never happen.
    const stem = sanitizeFilenameStem('Book \ud83d Title');
    expect(hasLoneSurrogate(stem)).toBe(false);
    expect(stem).toBe('Book Title');
  });

  it('removes an unpaired LOW surrogate too', () => {
    const stem = sanitizeFilenameStem('Book \udc00Title');
    expect(hasLoneSurrogate(stem)).toBe(false);
    expect(stem).toBe('Book Title');
  });

  it('counts a combining sequence by CODE POINT, not by grapheme', () => {
    // `e` + U+0301 is one grapheme but two code points, so 80 of them is 160 - the bound is
    // measured in code points, and a base may legitimately be cut from its mark.
    const stem = sanitizeFilenameStem('e\u0301'.repeat(80));
    expect(Array.from(stem)).toHaveLength(100);
    expect(stem).toBe('e\u0301'.repeat(50));
  });

  it('may legitimately return the empty string (AC19 consumes that outcome)', () => {
    expect(sanitizeFilenameStem('???')).toBe('');
    expect(sanitizeFilenameStem('')).toBe('');
    expect(sanitizeFilenameStem('   ...   ')).toBe('');
  });
});

describe('epubFilename - stem selection, THEN suffix (AC19)', () => {
  it('uses the sanitized title when it yields a non-empty stem', () => {
    expect(epubFilename({ title: 'The Hobbit', bookId: 'bk_abc' })).toBe('The Hobbit.epub');
  });

  it('falls back to the bookId when the title is absent or not a string (AC34)', () => {
    expect(epubFilename({ bookId: 'bk_abc' })).toBe('bk_abc.epub');
    expect(epubFilename({ title: ['A', 'B'], bookId: 'bk_abc' })).toBe('bk_abc.epub');
    expect(epubFilename({ title: 42, bookId: 'bk_abc' })).toBe('bk_abc.epub');
    expect(epubFilename({ title: '', bookId: 'bk_abc' })).toBe('bk_abc.epub');
  });

  it('a fully-stripped title yields <bookId>.epub - NEVER the bare ".epub"', () => {
    // The ordering receipt: suffixing before selecting a stem would make "???" look like the
    // non-empty stem ".epub" and win over the bookId fallback.
    expect(epubFilename({ title: '???', bookId: 'bk_abc' })).toBe('bk_abc.epub');
  });

  it('falls back to "companion" when the bookId sanitizes away too', () => {
    expect(epubFilename({ title: '???', bookId: '' })).toBe('companion.epub');
    expect(epubFilename({ bookId: '...' })).toBe('companion.epub');
  });

  it('does not double-suffix a stem that already ends .epub, case-insensitively', () => {
    expect(epubFilename({ title: 'Dune.epub', bookId: 'bk_abc' })).toBe('Dune.epub');
    expect(epubFilename({ title: 'Dune.EPUB', bookId: 'bk_abc' })).toBe('Dune.EPUB');
  });

  it('is never empty and never carries a separator, quote, backslash, CR or LF', () => {
    for (const title of ['a/b\\c', ' \r\n', '???', 'x'.repeat(400), 'Book \ud83d Title']) {
      const name = epubFilename({ title, bookId: 'bk_abc' });
      expect(name.length).toBeGreaterThan(0);
      expect(name).not.toMatch(/["\\/\r\n]/);
    }
  });
});

describe('contentDispositionAttachment - the header forms (AC13, AC20)', () => {
  it('emits only the quoted ASCII form for an ASCII filename', () => {
    expect(contentDispositionAttachment('The Hobbit.epub')).toBe('attachment; filename="The Hobbit.epub"');
  });

  it("adds an RFC 5987 filename* for non-ASCII, escaping ' ( ) that encodeURIComponent leaves raw", () => {
    // encodeURIComponent of a title with e-acute leaves the apostrophe and parentheses raw:
    // ECMAScript deliberately leaves - . ! ~ * ' ( ) unescaped, while RFC 5987's attr-char set
    // excludes ' ( ) * - so raw encodeURIComponent output is NOT a valid ext-value.
    const header = contentDispositionAttachment("L'\u00e9t\u00e9 (\u00e9dition).epub");
    expect(header).toBe(
      `attachment; filename="L'_t_ (_dition).epub"; filename*=UTF-8''L%27%C3%A9t%C3%A9%20%28%C3%A9dition%29.epub`,
    );
    expect(header).not.toMatch(/filename\*=UTF-8''[^;]*['()*]/);
  });

  it('percent-escapes a literal * in the ext-value (unreachable via AC18, correct for #148 anyway)', () => {
    expect(contentDispositionAttachment('\u00e9*.epub')).toContain("filename*=UTF-8''%C3%A9%2A.epub");
  });

  it('replaces every code point above U+007E with _ in the ASCII form', () => {
    expect(contentDispositionAttachment('\u65e5\u672c\u8a9e.epub')).toContain('filename="___.epub"');
  });

  it('falls back to companion.epub when the ASCII form has nothing usable', () => {
    expect(contentDispositionAttachment('')).toBe('attachment; filename="companion.epub"');
  });

  it('never throws, whatever string it is handed', () => {
    for (const name of ['\ud83d.epub', '\udc00', '', '\u{1F600}.epub', 'a"b\\c.epub']) {
      expect(() => contentDispositionAttachment(name)).not.toThrow();
    }
  });

  it('cannot be header-injected through the name it is given', () => {
    const header = contentDispositionAttachment(epubFilename({ title: 'a\r\nX-Evil: 1', bookId: 'bk_a' }));
    expect(header).not.toMatch(/[\r\n]/);
  });
});
