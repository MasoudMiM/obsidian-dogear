import esbuild from 'esbuild';
import process from 'process';
import builtins from 'module';

const banner = `/* Dogear — generated bundle. Source: https://github.com/MasoudMiM/obsidian-dogear */`;
const prod = process.argv[2] === 'production';

const ctx = await esbuild.context({
  banner: { js: banner },
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', ...builtins.builtinModules],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  minify: prod,
});

if (prod) { await ctx.rebuild(); process.exit(0); }
else { await ctx.watch(); }
