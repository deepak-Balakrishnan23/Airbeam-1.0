/**
 * What the browser will load, checked before a browser does.
 *
 * There is no build step, so nothing else notices a module path that moved
 * or a file the page links to that is not there: the page would simply stop
 * working. This walks everything the page reaches - index.html's links, every
 * static import, every `new URL(..., import.meta.url)`, the manifest's icons
 * and the service worker - and fails on a missing file or on any import that
 * is not a relative path, because a bare name would mean a package, and the
 * app has none.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const problems = []
const seen = new Set()

/** Every import or URL specifier a module names. */
function specifiers(source) {
  const found = []
  const patterns = [
    /\bimport\s+[^'"()]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"()]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
  ]
  for (const pattern of patterns) for (const m of source.matchAll(pattern)) found.push(m[1])
  return found
}

function visit(file, from) {
  if (seen.has(file)) return
  seen.add(file)
  if (!existsSync(file)) {
    problems.push(`${relative(root, file)} is missing (named by ${from})`)
    return
  }
  if (!/\.(m?js)$/.test(file)) return
  // Comments can quote code, so strip them before looking for imports.
  const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  for (const spec of specifiers(source)) {
    if (!spec.startsWith('./') && !spec.startsWith('../')) {
      problems.push(`${relative(root, file)} imports "${spec}", which is not a file of this app`)
      continue
    }
    visit(join(dirname(file), spec), relative(root, file))
  }
}

const html = readFileSync(join(root, 'index.html'), 'utf8')
for (const m of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
  if (/^[a-z]+:/i.test(m[1])) problems.push(`index.html links outside the app: ${m[1]}`)
  else visit(join(root, m[1]), 'index.html')
}

const manifestPath = join(root, 'public', 'manifest.webmanifest')
for (const icon of JSON.parse(readFileSync(manifestPath, 'utf8')).icons) visit(join(dirname(manifestPath), icon.src), 'the manifest')

visit(join(root, 'sw.js'), 'main.js (service worker)')

for (const problem of problems) console.log(`   FAIL ${problem}`)
console.log(problems.length ? `imports: ${problems.length} problem(s)` : `imports: all ${seen.size} files the page reaches are here, and all are the app's own`)
process.exitCode = problems.length ? 1 : 0
