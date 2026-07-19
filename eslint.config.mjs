// Obsidian's own plugin lint rules, plus type-aware TypeScript checks.
//
// These are the rules the community-plugin scorecard runs, so anything
// reported here would otherwise be found after release rather than before it.

import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default tseslint.config(
    {
        ignores: ['main.js', 'node_modules/**', 'test/**', 'esbuild.config.mjs'],
    },
    ...tseslint.configs.recommendedTypeChecked,
    ...obsidianmd.configs.recommended,
    {
        rules: {
            // Obsidian's style guide asks for sentence case *and* for correct
            // capitalisation of acronyms, proper nouns and trademarks. This
            // rule only implements the first half, so it reports "Goodreads",
            // "Google Books", "ISBN" and "Dogear" as mistakes. Every finding
            // it produced here was one of those, so it is off rather than
            // suppressed line by line.
            'obsidianmd/ui/sentence-case': 'off',
        },
    },
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
);
