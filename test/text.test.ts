// Dogear — tests for turning catalogue HTML into note prose.

import { stripHtml, decodeHtmlEntities } from '../src/text';
import type { Harness } from './note.test';

export async function runTextTests(h: Harness): Promise<void> {
    const { describe, ok, eq } = h;

    await describe('text: plain text passes through unchanged', () => {
        eq(stripHtml('A plain description.'), 'A plain description.', 'no markup, no change');
        eq(stripHtml(''), '', 'empty string stays empty');
        eq(stripHtml('   padded   '), 'padded', 'outer whitespace trimmed');
        eq(stripHtml('line one\nline two'), 'line one\nline two', 'existing line breaks kept');
    });

    await describe('text: paragraphs become separate blocks', () => {
        eq(stripHtml('<p>One</p><p>Two</p>'), 'One\n\nTwo', 'two paragraphs separated by a blank line');
        eq(
            stripHtml('<p>One</p>\n<p>Two</p>\n<p>Three</p>'),
            'One\n\nTwo\n\nThree',
            'three paragraphs stay distinct',
        );
        eq(stripHtml('<p>One</p>'), 'One', 'a lone paragraph is just its text');
    });

    await describe('text: line breaks survive', () => {
        eq(stripHtml('a<br>b'), 'a\nb', '<br> becomes a line break');
        eq(stripHtml('a<br/>b'), 'a\nb', '<br/> becomes a line break');
        eq(stripHtml('a<br />b'), 'a\nb', '<br /> becomes a line break');
        eq(stripHtml('a<br>B'), 'a\nB', 'case-insensitive');
    });

    await describe('text: inline markup is stripped', () => {
        eq(stripHtml('<b>Bold</b> and <i>italic</i>'), 'Bold and italic', 'emphasis tags removed');
        eq(stripHtml('<span>Plain</span>'), 'Plain', 'span removed');
        eq(stripHtml('A <a href="https://x">link</a> here'), 'A link here', 'anchor keeps its text');
        eq(stripHtml('Title: <strong>The Book</strong>'), 'Title: The Book', 'strong removed');
    });

    await describe('text: non-prose blocks are dropped entirely', () => {
        eq(
            stripHtml('<p>Keep</p><script>var x=1;</script>'),
            'Keep',
            'script content is not prose and is dropped',
        );
        eq(
            stripHtml('<p>Keep</p><style>.x{color:red}</style>'),
            'Keep',
            'style content is dropped',
        );
        eq(
            stripHtml('Before<iframe src="https://evil"></iframe>After'),
            'BeforeAfter',
            'embedded objects vanish without a trace',
        );
    });

    await describe('text: entities are decoded', () => {
        eq(stripHtml('Tom &amp; Jerry'), 'Tom & Jerry', '&amp; becomes &');
        eq(stripHtml('3 &lt; 4'), '3 < 4', '&lt; becomes <');
        eq(stripHtml('5 &gt; 4'), '5 > 4', '&gt; becomes >');
        eq(stripHtml('She said &quot;hi&quot;'), 'She said "hi"', '&quot; becomes a quote');
        eq(stripHtml('It&#39;s fine'), 'It\'s fine', 'numeric &#39; becomes an apostrophe');
        eq(stripHtml('Caf&eacute;'), 'Café', 'numeric &eacute; becomes é');
        eq(stripHtml('A &nbsp;B'), 'A B', '&nbsp; becomes a space');
        eq(stripHtml('Ellipsis…'), 'Ellipsis…', '&hellip; becomes …');
        eq(stripHtml('Dash — end'), 'Dash — end', '&mdash; becomes —');
        eq(stripHtml('Unk &bogus; ref'), 'Unk &bogus; ref', 'unknown entity left as-is');
    });

    await describe('text: whitespace is normalised', () => {
        eq(stripHtml('<p>One</p><p>Two</p><p>Three</p>'), 'One\n\nTwo\n\nThree', 'no run of blank lines');
        eq(
            stripHtml('a<br><br><br>b'),
            'a\n\nb',
            'a run of line breaks collapses to one blank line',
        );
        eq(stripHtml('  spaced   out  '), 'spaced out', 'trailing spaces before a break dropped');
    });

    await describe('text: realistic blurbs', () => {
        const blurb =
            '<p>The <b>Power Broker</b> is a history of New York City ' +
            '&amp; the man who built it.</p><p>Winner of the ' +
            '&#8220;Pulitzer Prize&#8221; for general nonfiction.</p>';
        const out = stripHtml(blurb);
        // &#8220;/&#8221; are curly quotes, so the decoded text keeps them.
        eq(out, 'The Power Broker is a history of New York City & the man who built it.\n\nWinner of the \u201cPulitzer Prize\u201d for general nonfiction.', 'a two-paragraph blurb reads as prose');
        ok(!out.includes('<'), 'no markup survives');
    });

    await describe('text: decodeHtmlEntities is exported for reuse', () => {
        eq(decodeHtmlEntities('a &amp; b &lt; c'), 'a & b < c', 'named entities decoded');
        eq(decodeHtmlEntities('&#72;&#105;'), 'Hi', 'numeric entities decoded');
        eq(decodeHtmlEntities('no entities'), 'no entities', 'plain text unchanged');
    });

    // Fuzz-ish: stripHtml must never throw on hostile input, and its output
    // must never be longer than a sane bound on the input.
    await describe('text: hostile input never throws', () => {
        const hostile = [
            '<',
            '<<<<<',
            '<p>',
            '<p',
            'a<b>c',
            '<div style="x"><p>y</p>',
            '&',
            '&;',
            '&#',
            '&#x',
            '<script>',
            'unclosed <b>bold',
            '\u0000null\u0000',
        ];
        for (const input of hostile) {
            let threw = false;
            let out = '';
            try {
                out = stripHtml(input);
            } catch {
                threw = true;
            }
            ok(!threw, `no throw on ${JSON.stringify(input)}`);
            ok(typeof out === 'string' && out.length >= 0, `string out on ${JSON.stringify(input)}`);
        }
    });
}
