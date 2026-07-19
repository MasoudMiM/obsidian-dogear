// Dogear — tests for the metadata provider chain.

import {
    buildGoogleSearchUrl,
    buildGoogleIsbnUrl,
    cleanGoogleThumbnail,
    mapGoogleResponse,
    googleHitToMetadata,
    GoogleBooksProvider,
    countryFromLocale,
    classifyGoogleError,
} from '../src/providers/googlebooks';
import { ProviderChain, mergeHits } from '../src/providers/chain';
import {
    AllProvidersFailedError,
    dedupeKey,
    normaliseIsbn,
    type BookMetadata,
    type BookProvider,
    type SearchHit,
} from '../src/providers/types';
import { workToHit } from '../src/providers/openlibrary';
import { ProviderConfigError, RateLimitError, type HttpResponse } from '../src/olclient';
import { mapSearchResponse } from '../src/openlibrary';
import {
    buildIaSearchUrl,
    escapeLucene,
    mapIaResponse,
    iaHitToMetadata,
    InternetArchiveProvider,
} from '../src/providers/internetarchive';
import {
    buildLocSearchUrl,
    mapLocResponse,
    locHitToMetadata,
    looksLikeJsonResults,
    normaliseLocImage,
    tidyContributor,
    LibraryOfCongressProvider,
    LOC_BLOCK_MS,
} from '../src/providers/loc';
import { TokenBucket, DailyBudget } from '../src/ratelimit';
import type { Harness } from './note.test';

// A realistic Google Books payload, shaped from the documented response.
const GOOGLE_JSON = {
    kind: 'books#volumes',
    totalItems: 2,
    items: [
        {
            kind: 'books#volume',
            id: 'hkEKEAAAQBAJ',
            volumeInfo: {
                title: 'The Power Broker',
                subtitle: 'Robert Moses and the Fall of New York',
                authors: ['Robert A. Caro'],
                publisher: 'Knopf',
                publishedDate: '1974-09-16',
                industryIdentifiers: [
                    { type: 'ISBN_10', identifier: '0394480767' },
                    { type: 'ISBN_13', identifier: '9780394480763' },
                ],
                pageCount: 1246,
                categories: ['Biography & Autobiography', 'Political Science'],
                imageLinks: {
                    smallThumbnail: 'http://books.google.com/books/content?id=x&zoom=5&edge=curl',
                    thumbnail: 'http://books.google.com/books/content?id=x&zoom=1&edge=curl',
                },
                language: 'en',
            },
        },
        { kind: 'books#volume', id: 'nofields' },
        {
            kind: 'books#volume',
            id: 'minimal',
            volumeInfo: { title: 'Just a Title' },
        },
    ],
};

export async function runProviderTests(h: Harness): Promise<void> {
    const { describe, ok, eq } = h;

    // --- google books mapping -----------------------------------------------

    await describe('google books: URL construction', () => {
        const url = buildGoogleSearchUrl('power broker', 20);
        ok(url.startsWith('https://www.googleapis.com/books/v1/volumes?'), 'endpoint correct');
        ok(url.includes('q=power+broker'), 'query encoded');
        ok(url.includes('maxResults=20'), 'limit passed');
        ok(url.includes('printType=books'), 'restricted to books, not magazines');
        ok(!url.includes('key='), 'no key sent when none is configured');

        ok(buildGoogleSearchUrl('x', 20, 'SECRET').includes('key=SECRET'), 'key included when set');
        ok(buildGoogleSearchUrl('x', 999).includes('maxResults=40'), 'limit clamped to the documented max');
        ok(buildGoogleSearchUrl('x', 0).includes('maxResults=1'), 'limit clamped to a minimum');
        ok(buildGoogleIsbnUrl('978-0-394-48076-3').includes('isbn%3A9780394480763'), 'ISBN query uses field syntax and strips punctuation');
    });

    await describe('google books: thumbnail cleaning', () => {
        eq(
            cleanGoogleThumbnail('http://books.google.com/books/content?id=x&zoom=1&edge=curl'),
            'https://books.google.com/books/content?id=x&zoom=1',
            'upgraded to https and the fake page-curl removed',
        );
        eq(
            cleanGoogleThumbnail('https://books.google.com/x?a=1'),
            'https://books.google.com/x?a=1',
            'a clean URL is left alone',
        );
    });

    await describe('google books: response mapping', () => {
        const hits = mapGoogleResponse(GOOGLE_JSON);
        eq(hits.length, 2, 'items without volumeInfo or title are skipped');

        const [caro, minimal] = hits;
        eq(caro.title, 'The Power Broker', 'title mapped');
        eq(caro.subtitle, 'Robert Moses and the Fall of New York', 'subtitle mapped');
        eq(caro.authors, ['Robert A. Caro'], 'authors mapped');
        eq(caro.pages, 1246, 'page count mapped');
        eq(caro.isbn13, '9780394480763', 'ISBN-13 picked out of industryIdentifiers');
        eq(caro.isbn10, '0394480767', 'ISBN-10 picked out too');
        eq(caro.publisher, 'Knopf', 'publisher mapped');
        eq(caro.year, 1974, 'year extracted from the publication date');
        eq(caro.tags.length, 2, 'categories became tags');
        ok(caro.coverUrl?.startsWith('https://') ?? false, 'cover upgraded to https');
        eq(caro.complete, true, 'Google hits need no second request');

        eq(minimal.title, 'Just a Title', 'a sparse record still maps');
        eq(minimal.authors, [], 'missing authors become an empty list');
        eq(minimal.pages, undefined, 'missing page count stays undefined');

        eq(mapGoogleResponse({}), [], 'empty response handled');
        eq(mapGoogleResponse(null), [], 'null response handled');
        eq(mapGoogleResponse({ items: 'nonsense' }), [], 'garbage items handled');
    });

    await describe('google books: metadata conversion', () => {
        const [caro] = mapGoogleResponse(GOOGLE_JSON);
        const meta = googleHitToMetadata(caro);
        eq(
            meta.title,
            'The Power Broker: Robert Moses and the Fall of New York',
            'subtitle folded into the title',
        );
        eq(meta.pages, 1246, 'page count carried over');
        eq(meta.googleId, 'hkEKEAAAQBAJ', 'volume id retained');
        eq(meta.source, 'googlebooks', 'source recorded');
        eq(meta.olWork, undefined, 'no Open Library keys on a Google record');
    });

    await describe('google books: country detection from locale', () => {
        eq(countryFromLocale('en-US'), 'US', 'region extracted');
        eq(countryFromLocale('en-GB'), 'GB', 'British English');
        eq(countryFromLocale('pt-BR'), 'BR', 'Brazilian Portuguese');
        eq(countryFromLocale('fa_IR'), 'IR', 'underscore separator accepted');
        eq(countryFromLocale('zh-Hans-CN'), undefined, 'script subtag is not a country');
        eq(countryFromLocale('en'), undefined, 'a bare language carries no region');
        eq(countryFromLocale(''), undefined, 'empty locale');
        eq(countryFromLocale(undefined), undefined, 'missing locale');
    });

    await describe('google books: country parameter is always sent', () => {
        // Google refuses requests it cannot geolocate, so omitting this makes
        // every search fail with a 403 that looks like a quota problem.
        ok(buildGoogleSearchUrl('x', 20, undefined, 'GB').includes('country=GB'), 'country included in search');
        ok(buildGoogleIsbnUrl('123', undefined, 'GB').includes('country=GB'), 'country included in ISBN lookup');
        ok(!buildGoogleSearchUrl('x', 20).includes('country='), 'omitted when not supplied');
    });

    await describe('google books: 403 is ambiguous and must be classified', () => {
        // The exact payload Google returns when it cannot geolocate the caller.
        const unknownLocation = {
            error: {
                errors: [
                    {
                        domain: 'global',
                        reason: 'unknownLocation',
                        message: 'Cannot determine user location for geographically restricted operation.',
                    },
                ],
                code: 403,
                message: 'Cannot determine user location for geographically restricted operation.',
            },
        };
        const located = classifyGoogleError(403, unknownLocation);
        eq(located.kind, 'unknown-location', 'geolocation failure identified, not mistaken for quota');
        ok(/determine user location/i.test(located.message), 'the real message is preserved');

        const quota = classifyGoogleError(403, {
            error: { errors: [{ reason: 'rateLimitExceeded' }], code: 403, message: 'Rate Limit Exceeded' },
        });
        eq(quota.kind, 'rate-limit', 'quota exhaustion identified');

        eq(classifyGoogleError(429, null).kind, 'rate-limit', 'a plain 429 is rate limiting');
        eq(classifyGoogleError(500, null, 'boom').kind, 'other', 'server errors are neither');
        // An unexplained 403 must NOT be assumed to be a quota problem.
        // Guessing here is exactly what hid a geolocation failure behind a
        // five-minute cooldown and cost a debugging round trip.
        eq(classifyGoogleError(403, null).kind, 'other', 'an unexplained 403 is not guessed at');
        eq(
            classifyGoogleError(403, { error: { message: 'Daily Limit Exceeded' } }).kind,
            'daily-quota',
            'a daily limit is distinguished from a per-second one',
        );

        // The exact message Google returned during testing. Keyless callers
        // share one anonymous project, so this pool is exhausted by strangers.
        const shared = classifyGoogleError(429, {
            error: {
                message:
                    "Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'books.googleapis.com' for consumer 'project_number:624717413613'.",
            },
        });
        eq(shared.kind, 'daily-quota', 'the shared keyless pool being empty is a daily quota');
        ok(/project_number/.test(shared.message), 'the full detail is preserved');
    });

    await describe('google books: a geolocation failure is reported as fixable', async () => {
        let clock = 0;
        const provider = new GoogleBooksProvider(
            async () =>
                ({
                    status: 403,
                    json: {
                        error: {
                            errors: [{ reason: 'unknownLocation' }],
                            message: 'Cannot determine user location for geographically restricted operation.',
                        },
                    },
                }) as HttpResponse,
            { now: () => clock },
        );
        let err: Error | null = null;
        try {
            await provider.search('x');
        } catch (e) {
            err = e as Error;
        }
        ok(err instanceof ProviderConfigError, 'raised as a configuration problem');
        ok(/country/i.test((err as ProviderConfigError).remedy), 'the remedy mentions the country setting');
        // Crucially: no cooldown. Waiting would not help, and would block the
        // provider for five minutes for no reason.
        eq(provider.cooldownRemaining(), 0, 'no pointless cooldown for a fixable problem');
    });

    await describe('google books: an exhausted daily quota is fixable, not waitable', async () => {
        // Waiting five minutes against a per-DAY limit is a slower way of
        // being broken. The remedy is a key, so say so.
        const quotaBody = {
            error: {
                message:
                    "Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'books.googleapis.com' for consumer 'project_number:624717413613'.",
            },
        };
        const keyless = new GoogleBooksProvider(
            async () => ({ status: 429, json: quotaBody }) as HttpResponse,
            {},
        );
        let err: Error | null = null;
        try {
            await keyless.search('x');
        } catch (e) {
            err = e as Error;
        }
        ok(err instanceof ProviderConfigError, 'raised as something the reader can act on');
        ok(/shared/i.test(err?.message ?? ''), 'explains the pool is shared with other callers');
        ok(/API key/i.test((err as ProviderConfigError).remedy), 'the remedy is to add a key');

        // With a key configured the advice must change: it is now your own
        // quota, and there is nothing to configure.
        const keyed = new GoogleBooksProvider(
            async () => ({ status: 429, json: quotaBody }) as HttpResponse,
            { apiKey: 'SECRET' },
        );
        let err2: ProviderConfigError | null = null;
        try {
            await keyed.search('x');
        } catch (e) {
            err2 = e as ProviderConfigError;
        }
        ok(/resets daily/i.test(err2?.remedy ?? ''), 'with a key, the advice is to wait for the reset');
        ok(!/add a free/i.test(err2?.remedy ?? ''), 'and does not tell you to add a key you already have');
    });

    await describe('google books: quota exhaustion does cool down', async () => {
        let clock = 0;
        const provider = new GoogleBooksProvider(
            async () => ({ status: 429, json: null }) as HttpResponse,
            { now: () => clock, defaultCooldownMs: 60_000 },
        );
        let err: Error | null = null;
        try {
            await provider.search('x');
        } catch (e) {
            err = e as Error;
        }
        ok(err instanceof RateLimitError, 'rate limiting raised');
        ok(/Google Books/.test(err?.message ?? ''), 'the message names Google Books, not Open Library');
        ok(provider.cooldownRemaining() > 0, 'provider stands down');
        clock += 61_000;
        eq(provider.cooldownRemaining(), 0, 'cooldown expires');
    });

    await describe('google books: caching', async () => {
        let calls = 0;
        let clock = 0;
        const provider = new GoogleBooksProvider(
            async () => {
                calls++;
                return { status: 200, json: GOOGLE_JSON } as HttpResponse;
            },
            { now: () => clock, ttlMs: 1000 },
        );
        await provider.search('power broker');
        await provider.search('power broker');
        eq(calls, 1, 'repeat query served from cache');
        clock += 2000;
        await provider.search('power broker');
        eq(calls, 2, 'refetched after the cache expires');
    });

    // --- the chain ----------------------------------------------------------

    /** Minimal provider stub. */
    function stubProvider(
        id: string,
        behaviour: {
            hits?: SearchHit[];
            error?: Error;
            cooldown?: number;
        },
    ): BookProvider & { calls: number } {
        const p = {
            id,
            label: id,
            attribution: id,
            calls: 0,
            cooldownRemaining: () => behaviour.cooldown ?? 0,
            async search(): Promise<SearchHit[]> {
                p.calls++;
                if (behaviour.error) throw behaviour.error;
                return behaviour.hits ?? [];
            },
            async resolve(hit: SearchHit): Promise<BookMetadata> {
                return {
                    title: hit.title,
                    authors: hit.authors,
                    tags: [],
                    source: id,
                };
            },
        };
        return p;
    }

    const hit = (title: string, providerId: string): SearchHit => ({
        providerId,
        id: title,
        title,
        authors: ['Someone'],
        tags: [],
        complete: true,
    });

    await describe('chain: first healthy provider answers', async () => {
        const first = stubProvider('first', { hits: [hit('A', 'first')] });
        const second = stubProvider('second', { hits: [hit('B', 'second')] });
        const chain = new ProviderChain(() => [first, second]);

        const result = await chain.search('anything');
        eq(result.usedProvider, 'first', 'the first provider is used');
        eq(result.hits.length, 1, 'its results are returned');
        eq(second.calls, 0, 'the second provider is never asked');
    });

    await describe('chain: falls through when the first is rate limited', async () => {
        // This is the exact situation that motivated the chain.
        const ol = stubProvider('openlibrary', { error: new RateLimitError(60_000) });
        const google = stubProvider('googlebooks', { hits: [hit('The Power Broker', 'googlebooks')] });
        const chain = new ProviderChain(() => [ol, google]);

        const result = await chain.search('power broker');
        eq(result.usedProvider, 'googlebooks', 'the fallback answered');
        eq(result.hits[0].title, 'The Power Broker', 'the reader still gets their book');
        eq(result.failures.length, 1, 'the failure is recorded, not hidden');
        ok(/rate limiting/i.test(result.failures[0].reason), 'the reason is preserved');
    });

    await describe('chain: a cooling-down provider is skipped without a request', async () => {
        const ol = stubProvider('openlibrary', {
            hits: [hit('A', 'openlibrary')],
            cooldown: 30_000,
        });
        const google = stubProvider('googlebooks', { hits: [hit('B', 'googlebooks')] });
        const chain = new ProviderChain(() => [ol, google]);

        const result = await chain.search('x');
        eq(ol.calls, 0, 'no request is sent to a throttled provider');
        eq(result.usedProvider, 'googlebooks', 'the next provider answers');
        eq(result.skipped, ['openlibrary'], 'the skip is reported');
    });

    await describe('chain: zero results is not a failure', async () => {
        const first = stubProvider('first', { hits: [] });
        const second = stubProvider('second', { hits: [hit('Found it', 'second')] });
        const chain = new ProviderChain(() => [first, second]);

        const result = await chain.search('obscure');
        eq(first.calls, 1, 'the first provider was asked');
        eq(result.usedProvider, 'second', 'a second source found what the first could not');
        eq(result.failures.length, 0, 'an honest empty answer is not recorded as a failure');
    });

    await describe('chain: all providers empty returns nothing, not an error', async () => {
        const chain = new ProviderChain(() => [
            stubProvider('a', { hits: [] }),
            stubProvider('b', { hits: [] }),
        ]);
        const result = await chain.search('qqqzzz');
        eq(result.hits, [], 'no results');
        eq(result.usedProvider, null, 'no provider claimed the answer');
        eq(result.failures, [], 'no failures reported');
    });

    await describe('chain: only errors when every provider fails', async () => {
        const chain = new ProviderChain(() => [
            stubProvider('a', { error: new Error('boom') }),
            stubProvider('b', { error: new RateLimitError(30_000) }),
        ]);
        let err: AllProvidersFailedError | null = null;
        try {
            await chain.search('x');
        } catch (e) {
            err = e as AllProvidersFailedError;
        }
        ok(err?.name === 'AllProvidersFailedError', 'a dedicated error is raised');
        eq(err?.failures.length, 2, 'every failure is listed');
        ok(/boom/.test(err?.message ?? ''), 'the first reason appears in the message');
        ok(/rate limiting/i.test(err?.message ?? ''), 'the second reason appears too');
    });

    await describe('errors: failures always carry the underlying detail', async () => {
        // Regression guard. Four separate times, an error message summarised
        // the problem and discarded what the server actually said, which made
        // the cause impossible to see from the interface.
        const limited = new RateLimitError(30_000, 'Google Books', 'Daily Limit Exceeded');
        ok(/Google Books/.test(limited.message), 'the provider is named');
        ok(/Daily Limit Exceeded/.test(limited.message), 'the server response is included');
        eq(limited.detail, 'Daily Limit Exceeded', 'and is available separately');

        const provider = new GoogleBooksProvider(
            async () =>
                ({
                    status: 403,
                    json: { error: { message: 'Daily Limit Exceeded', errors: [{ reason: 'dailyLimitExceeded' }] } },
                }) as HttpResponse,
            {},
        );
        let err: Error | null = null;
        try {
            await provider.search('x');
        } catch (e) {
            err = e as Error;
        }
        ok(/Daily Limit Exceeded/.test(err?.message ?? ''), 'the reason reaches the surface');

        // An unexplained failure must still say what came back.
        const opaque = new GoogleBooksProvider(
            async () => ({ status: 451, json: null, bodySnippet: 'blocked in your region' }) as HttpResponse,
            {},
        );
        let err2: Error | null = null;
        try {
            await opaque.search('x');
        } catch (e) {
            err2 = e as Error;
        }
        ok(/451/.test(err2?.message ?? ''), 'the status code is reported');
        ok(/blocked in your region/.test(err2?.message ?? ''), 'the body is reported');
    });

    await describe('chain: a fixable failure is not buried by an unfixable one', async () => {
        const chain = new ProviderChain(() => [
            stubProvider('ol', { error: new RateLimitError(60_000, 'Open Library') }),
            stubProvider('gb', {
                error: new ProviderConfigError('Cannot determine your country', 'Set a country code.'),
            }),
        ]);
        let err: AllProvidersFailedError | null = null;
        try {
            await chain.search('x');
        } catch (e) {
            err = e as AllProvidersFailedError;
        }
        eq(err?.errors.length, 2, 'the underlying errors are preserved, not just their text');
        const fixable = err?.errors.find((e) => e.name === 'ProviderConfigError');
        ok(fixable !== undefined, 'the actionable error can still be found and shown');
    });

    await describe('chain: a provider needing setup is skipped, not attempted', async () => {
        // Google Books without a key cannot succeed: the key-free quota is a
        // single shared pool that is effectively always spent. Trying anyway
        // wastes a request and produces an error that reads like user error.
        const google = new GoogleBooksProvider(async () => {
            throw new Error('should never be called');
        }, {});
        ok(google.unavailableReason() !== null, 'keyless Google reports itself unusable');
        ok(/API key/i.test(google.unavailableReason() ?? ''), 'and says why');

        const keyed = new GoogleBooksProvider(async () => ({ status: 200, json: {} }) as HttpResponse, {
            apiKey: 'SECRET',
        });
        eq(keyed.unavailableReason(), null, 'with a key it becomes usable');

        // The chain must skip it without a request and carry on.
        const archive = stubProvider('internetarchive', { hits: [hit('A book', 'internetarchive')] });
        const chain = new ProviderChain(() => [google, archive]);
        const result = await chain.search('anything');
        eq(result.usedProvider, 'internetarchive', 'the next source answered');
        eq(result.skipped, ['googlebooks'], 'the unusable source was skipped');
        ok(
            result.failures.some((f) => /API key/i.test(f.reason)),
            'and the reason is reported so settings can explain it',
        );
    });

    await describe('chain: no providers configured', async () => {
        const chain = new ProviderChain(() => []);
        const result = await chain.search('x');
        eq(result.hits, [], 'returns nothing rather than throwing');
        eq(result.usedProvider, null, 'no provider used');
    });

    await describe('chain: resolve routes back to the originating provider', async () => {
        const a = stubProvider('a', { hits: [] });
        const b = stubProvider('b', { hits: [] });
        const chain = new ProviderChain(() => [a, b]);

        const meta = await chain.resolve(hit('Book', 'b'));
        eq(meta.source, 'b', 'resolved by the provider that produced the hit');

        let threw = false;
        try {
            await chain.resolve(hit('Book', 'nonexistent'));
        } catch {
            threw = true;
        }
        ok(threw, 'an unknown provider id is an error, not a silent wrong answer');
    });

    // --- deduplication ------------------------------------------------------

    await describe('providers: identifying the same book across sources', () => {
        eq(normaliseIsbn('978-0-394-48076-3'), '9780394480763', 'punctuation stripped');
        eq(normaliseIsbn('043902348x'), '043902348X', 'check digit upper-cased');
        eq(normaliseIsbn(''), undefined, 'blank is undefined');

        const olHit: SearchHit = {
            providerId: 'openlibrary',
            id: '/works/OL1W',
            title: 'The Power Broker',
            authors: ['Robert A. Caro'],
            isbn13: '978-0-394-48076-3',
            tags: [],
            complete: false,
        };
        const googleHit: SearchHit = {
            providerId: 'googlebooks',
            id: 'abc',
            title: 'The Power Broker',
            authors: ['Robert A. Caro'],
            isbn13: '9780394480763',
            tags: [],
            complete: true,
        };
        eq(dedupeKey(olHit), dedupeKey(googleHit), 'matched by ISBN despite different formatting');

        // Without an ISBN, fall back to title and author.
        const noIsbnA = { ...olHit, isbn13: undefined };
        const noIsbnB = { ...googleHit, isbn13: undefined, title: 'the power  broker!' };
        eq(dedupeKey(noIsbnA), dedupeKey(noIsbnB), 'matched by normalised title and author');

        const different = { ...noIsbnA, title: 'Something Else' };
        ok(dedupeKey(noIsbnA) !== dedupeKey(different), 'different books stay distinct');
    });

    await describe('providers: merging results keeps the first of each book', () => {
        const a: SearchHit = {
            providerId: 'openlibrary',
            id: '1',
            title: 'Dune',
            authors: ['Frank Herbert'],
            isbn13: '9780441013593',
            tags: [],
            complete: false,
        };
        const b: SearchHit = { ...a, providerId: 'googlebooks', id: '2' };
        const c: SearchHit = { ...a, id: '3', title: 'Dune Messiah', isbn13: '9780593098233' };

        const merged = mergeHits([[a], [b, c]]);
        eq(merged.length, 2, 'the duplicate is dropped');
        eq(merged[0].providerId, 'openlibrary', 'the first source wins');
        eq(merged[1].title, 'Dune Messiah', 'the distinct book is kept');
    });

    // --- open library adapter -----------------------------------------------

    await describe('open library: work maps into a neutral hit', () => {
        const work = mapSearchResponse({
            docs: [
                {
                    key: '/works/OL27448W',
                    title: 'The Dispossessed',
                    author_name: ['Ursula K. Le Guin'],
                    first_publish_year: 1974,
                    cover_i: 240727,
                    number_of_pages_median: 341,
                    isbn: ['9780060512750'],
                    publisher: ['Harper'],
                    subject: ['Science fiction'],
                },
            ],
        })[0];

        const h = workToHit(work);
        eq(h.providerId, 'openlibrary', 'provider recorded');
        eq(h.id, '/works/OL27448W', 'work key becomes the id');
        eq(h.pages, 341, 'median page count carried through');
        eq(h.complete, false, 'an Open Library work still needs resolving');
        ok(h.coverUrl?.includes('240727') ?? false, 'cover URL built');
        eq(h.raw, work, 'the original work is kept for resolve()');
    });

    // --- proactive rate limiting --------------------------------------------

    await describe('rate limiting: token bucket basics', () => {
        let clock = 0;
        const bucket = new TokenBucket({
            capacity: 3,
            refillPerSecond: 1,
            now: () => clock,
            sleep: async (ms) => {
                clock += ms;
            },
        });

        eq(bucket.available(), 3, 'starts full so the first search is instant');
        ok(bucket.tryTake(), 'first token granted');
        ok(bucket.tryTake(), 'second granted');
        ok(bucket.tryTake(), 'third granted');
        ok(!bucket.tryTake(), 'burst exhausted, fourth refused');
        eq(bucket.delayUntilReady(), 1000, 'reports a one second wait at 1/s');

        clock += 1000;
        ok(bucket.tryTake(), 'a token refills after a second');

        clock += 60_000;
        eq(bucket.available(), 3, 'refill is capped at capacity, no unbounded credit');
    });

    await describe('rate limiting: waiting for a token', async () => {
        let clock = 0;
        const bucket = new TokenBucket({
            capacity: 1,
            refillPerSecond: 2,
            now: () => clock,
            sleep: async (ms) => {
                clock += ms;
            },
        });

        await bucket.take();
        eq(bucket.stats.waited, 0, 'the first token is immediate');

        await bucket.take();
        ok(bucket.stats.waited === 1, 'the second waits');
        ok(clock >= 500, 'and time actually advanced by the refill interval');
        eq(bucket.stats.granted, 2, 'both requests eventually proceeded');
    });

    await describe('rate limiting: a throttled provider still gets throttled requests', async () => {
        // The bucket must sit in front of the request, not behind it.
        let clock = 0;
        let requests = 0;
        const bucket = new TokenBucket({
            capacity: 2,
            refillPerSecond: 1,
            now: () => clock,
            sleep: async (ms) => {
                clock += ms;
            },
        });
        const provider = new GoogleBooksProvider(
            async () => {
                requests++;
                return { status: 200, json: GOOGLE_JSON } as HttpResponse;
            },
            { bucket, now: () => clock, ttlMs: 0 },
        );

        await provider.search('a');
        await provider.search('b');
        eq(requests, 2, 'the burst goes straight out');
        const before = clock;
        await provider.search('c');
        ok(clock > before, 'the third request waited for a token rather than being refused');
        eq(requests, 3, 'and still completed');
    });

    await describe('rate limiting: daily budget', () => {
        let clock = Date.parse('2026-07-18T10:00:00');
        const budget = new DailyBudget(3, () => clock);

        eq(budget.remaining(), 3, 'starts with the full allowance');
        ok(budget.consume(), 'first spend allowed');
        ok(budget.consume(), 'second allowed');
        ok(budget.consume(), 'third allowed');
        ok(!budget.consume(), 'fourth refused');
        eq(budget.remaining(), 0, 'nothing left');
        eq(budget.spent(), 3, 'spend counted');

        // Crossing midnight resets it.
        clock = Date.parse('2026-07-19T00:05:00');
        eq(budget.remaining(), 3, 'allowance resets the next day');
        ok(budget.consume(), 'and spending resumes');

        // Restoring a snapshot from the same day preserves the count.
        const snap = budget.snapshot();
        const restored = new DailyBudget(3, () => clock);
        restored.restore(snap.day, snap.used);
        eq(restored.spent(), snap.used, 'a saved count survives a restart');

        // A snapshot from a previous day must be ignored.
        const stale = new DailyBudget(3, () => clock);
        stale.restore('1999-1-1', 99);
        eq(stale.spent(), 0, 'yesterday\'s usage is not carried forward');
    });

    // --- internet archive ---------------------------------------------------

    const IA_JSON = {
        response: {
            numFound: 2,
            docs: [
                {
                    identifier: 'powerbrokerrober00caro',
                    title: 'The power broker : Robert Moses and the fall of New York',
                    creator: ['Caro, Robert A.'],
                    year: '1975',
                    publisher: 'New York : Vintage Books',
                    imagecount: 1350,
                    subject: ['Moses, Robert', 'City planning'],
                    isbn: '9780394480763',
                },
                // The Archive often returns bare strings where lists are expected.
                {
                    identifier: 'scalarform',
                    title: 'A Scalar Title',
                    creator: 'Single Author',
                    date: '1962-01-01',
                    subject: 'One Subject',
                },
                { identifier: 'no-title' },
                { title: 'no identifier' },
            ],
        },
    };

    await describe('internet archive: URL construction', () => {
        const url = buildIaSearchUrl('power broker', 20);
        ok(url.startsWith('https://archive.org/advancedsearch.php?'), 'endpoint correct');
        ok(url.includes('mediatype%3Atexts'), 'restricted to texts, not film or audio');
        ok(url.includes('output=json'), 'JSON output requested');
        ok(url.includes('fl%5B%5D=identifier'), 'fields requested explicitly');
        ok(buildIaSearchUrl('x', 999).includes('rows=50'), 'row count clamped');

        // The relevance fix. A bare query searches every indexed field
        // including full text, which returned scanned government memos that
        // merely contained the words "power broker".
        const decoded = decodeURIComponent(url);
        ok(decoded.includes('title:('), 'searches the title field');
        ok(decoded.includes('creator:('), 'and the creator field');
        ok(!/^q=\(power broker\)/.test(decoded), 'does not search every field indiscriminately');
    });

    await describe('internet archive: query escaping', () => {
        // Titles routinely contain characters Lucene treats as operators.
        eq(escapeLucene('power broker'), 'power broker', 'ordinary text untouched');
        ok(escapeLucene('The Dispossessed: An Ambiguous Utopia').includes('\\:'), 'colon escaped');
        ok(escapeLucene('Nineteen Eighty-Four').includes('\\-'), 'hyphen escaped');
        ok(escapeLucene('Who? Me!').includes('\\?'), 'question mark escaped');
        ok(escapeLucene('a "quoted" title').includes('\\"'), 'quotes escaped');

        // And the escaping survives into the URL.
        const tricky = decodeURIComponent(buildIaSearchUrl('Nineteen Eighty-Four'));
        ok(tricky.includes('Eighty\\-Four'), 'escaped title reaches the query');
    });

    await describe('internet archive: response mapping', () => {
        const hits = mapIaResponse(IA_JSON);
        eq(hits.length, 2, 'records without an identifier or title are skipped');

        const [caro, scalar] = hits;
        eq(caro.providerId, 'internetarchive', 'provider recorded');
        eq(caro.authors, ['Caro, Robert A.'], 'creator list mapped');
        eq(caro.year, 1975, 'year parsed');
        eq(caro.pages, 1350, 'scan image count used as an approximate page count');
        eq(caro.isbn13, '9780394480763', 'ISBN-13 recognised by length');
        ok(caro.coverUrl?.includes('powerbrokerrober00caro') ?? false, 'cover URL built from the identifier');

        // The Archive is inconsistent about scalars vs lists; both must work.
        eq(scalar.authors, ['Single Author'], 'a bare string creator is accepted');
        eq(scalar.tags, ['One Subject'], 'a bare string subject is accepted');
        eq(scalar.year, 1962, 'year extracted from a full date');
        eq(scalar.pages, undefined, 'no image count means no page estimate');

        eq(mapIaResponse({}), [], 'empty response handled');
        eq(mapIaResponse(null), [], 'null response handled');
        eq(mapIaResponse({ response: { docs: 'nonsense' } }), [], 'garbage docs handled');
    });

    await describe('internet archive: metadata conversion and failures', async () => {
        const [caro] = mapIaResponse(IA_JSON);
        const meta = iaHitToMetadata(caro);
        eq(meta.source, 'internetarchive', 'source recorded');
        eq(meta.pages, 1350, 'page estimate carried through');

        let clock = 0;
        const provider = new InternetArchiveProvider(
            async () => ({ status: 503, json: null, bodySnippet: 'busy' }) as HttpResponse,
            { now: () => clock, defaultCooldownMs: 30_000 },
        );
        let err: Error | null = null;
        try {
            await provider.search('x');
        } catch (e) {
            err = e as Error;
        }
        ok(err instanceof RateLimitError, 'a 503 stands the provider down');
        ok(/Internet Archive/.test(err?.message ?? ''), 'the message names the right service');
        ok(/busy/.test(err?.message ?? ''), 'the body is included');
    });

    await describe('chain: three sources, only the last one healthy', async () => {
        // The situation this whole layer exists for.
        const chain = new ProviderChain(() => [
            stubProvider('openlibrary', { error: new RateLimitError(60_000, 'Open Library') }),
            stubProvider('googlebooks', {
                error: new ProviderConfigError('Shared quota exhausted', 'Add a key.'),
            }),
            stubProvider('internetarchive', { hits: [hit('The Power Broker', 'internetarchive')] }),
        ]);
        const result = await chain.search('power broker');
        eq(result.usedProvider, 'internetarchive', 'the third source answered');
        eq(result.hits.length, 1, 'the reader gets their book');
        eq(result.failures.length, 2, 'both earlier failures recorded');
    });

    // --- library of congress ------------------------------------------------

    const LOC_JSON = {
        results: [
            {
                id: 'https://www.loc.gov/item/74007243/',
                title: 'The power broker : Robert Moses and the fall of New York',
                contributor: ['caro, robert a.'],
                date: '1974',
                subject: ['moses, robert', 'city planning'],
                original_format: ['book'],
                image_url: ['//cdn.loc.gov/service/pnp/x/0001_150px.jpg'],
            },
            // Collections and web pages are not books.
            {
                id: 'https://www.loc.gov/collections/something/',
                title: 'A collection about power',
                original_format: ['collection'],
            },
            {
                id: 'https://www.loc.gov/item/webpage/',
                title: 'A web page',
                original_format: ['web page'],
            },
            // The Library warns its data is heterogenous: scalars where lists
            // are expected, missing fields, numeric dates.
            {
                id: 'https://www.loc.gov/item/scalar/',
                title: 'A scalar record',
                contributor: 'single, author',
                date: 1962,
                subject: 'one subject',
            },
            { title: 'no id' },
            { id: 'https://www.loc.gov/item/no-title/' },
        ],
    };

    await describe('library of congress: URL construction', () => {
        const url = buildLocSearchUrl('power broker', 20);
        ok(url.startsWith('https://www.loc.gov/books/?'), 'uses the books endpoint, not general search');
        ok(url.includes('fo=json'), 'JSON format requested');
        ok(url.includes('at=results'), 'asks only for results, not facets and site furniture');
        ok(url.includes('c=20'), 'result count passed');
        ok(buildLocSearchUrl('x', 999).includes('c=50'), 'count clamped');
    });

    await describe('library of congress: defensive mapping', () => {
        const hits = mapLocResponse(LOC_JSON);
        eq(hits.length, 2, 'collections, web pages and malformed records are all dropped');

        const [caro, scalar] = hits;
        eq(caro.title, 'The power broker : Robert Moses and the fall of New York', 'title mapped');
        eq(caro.authors, ['Caro, Robert A.'], 'inverted lower-case contributor tidied');
        eq(caro.year, 1974, 'year parsed');
        eq(caro.pages, undefined, 'no page count is invented when the record has none');
        ok(caro.coverUrl?.startsWith('https://') ?? false, 'protocol-relative image URL made absolute');
        eq(caro.tags.length, 2, 'subjects captured');

        eq(scalar.authors, ['Single, Author'], 'a bare string contributor is accepted');
        eq(scalar.year, 1962, 'a numeric date is accepted');
        eq(scalar.tags, ['one subject'], 'a bare string subject is accepted');

        eq(mapLocResponse({}), [], 'empty response handled');
        eq(mapLocResponse(null), [], 'null response handled');
        eq(mapLocResponse({ results: 'nonsense' }), [], 'garbage results handled');

        eq(locHitToMetadata(caro).source, 'loc', 'source recorded');
    });

    await describe('library of congress: helpers', () => {
        eq(normaliseLocImage('//cdn.loc.gov/a.jpg'), 'https://cdn.loc.gov/a.jpg', 'protocol-relative fixed');
        eq(normaliseLocImage('http://cdn.loc.gov/a.jpg'), 'https://cdn.loc.gov/a.jpg', 'http upgraded');
        eq(normaliseLocImage('https://cdn.loc.gov/a.jpg'), 'https://cdn.loc.gov/a.jpg', 'https untouched');

        eq(tidyContributor('caro, robert a.'), 'Caro, Robert A.', 'name title-cased');
        eq(tidyContributor('le guin, ursula k.'), 'Le Guin, Ursula K.', 'multi-word surname');
        eq(tidyContributor('smith, john,'), 'Smith, John', 'trailing comma removed');

        ok(looksLikeJsonResults({ results: [] }), 'a results array is valid');
        ok(!looksLikeJsonResults(null), 'null is not');
        ok(!looksLikeJsonResults('<html>captcha</html>'), 'an HTML string is not');
        ok(!looksLikeJsonResults({ nope: 1 }), 'an object without results is not');
    });

    await describe('library of congress: a CAPTCHA page is throttling in disguise', async () => {
        // The Library may serve HTML with a 200 status when under load. Their
        // own example code checks the content type rather than the status.
        // Treating it as "no results" would hide the problem AND keep us
        // hammering a service that has just asked us to stop.
        let clock = 0;
        const provider = new LibraryOfCongressProvider(
            async () => ({ status: 200, json: null, bodySnippet: '<html>...' }) as HttpResponse,
            { now: () => clock },
        );
        let err: Error | null = null;
        try {
            await provider.search('x');
        } catch (e) {
            err = e as Error;
        }
        ok(err instanceof RateLimitError, 'treated as rate limiting, not as an empty result');
        ok(/Library of Congress/.test(err?.message ?? ''), 'names the service');
        eq(provider.cooldownRemaining(), LOC_BLOCK_MS, 'stands down for the documented hour');
    });

    await describe('library of congress: a 429 blocks for an hour', async () => {
        let clock = 0;
        const provider = new LibraryOfCongressProvider(
            async () => ({ status: 429, json: null }) as HttpResponse,
            { now: () => clock },
        );
        try {
            await provider.search('x');
        } catch {
            /* expected */
        }
        // The penalty here is far harsher than any other source, so the
        // cooldown must match it rather than the usual minute.
        eq(provider.cooldownRemaining(), LOC_BLOCK_MS, 'full hour, matching the documented block');
        clock += LOC_BLOCK_MS + 1;
        eq(provider.cooldownRemaining(), 0, 'and it does expire');
    });

    await describe('library of congress: successful search caches', async () => {
        let calls = 0;
        let clock = 0;
        const provider = new LibraryOfCongressProvider(
            async () => {
                calls++;
                return { status: 200, json: LOC_JSON } as HttpResponse;
            },
            { now: () => clock, ttlMs: 1000 },
        );
        const first = await provider.search('power broker');
        eq(first.length, 2, 'results returned');
        await provider.search('power broker');
        eq(calls, 1, 'repeat query served from cache, as the Library asks');
        clock += 2000;
        await provider.search('power broker');
        eq(calls, 2, 'refetched after expiry');
    });
}
