#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const ignore = require("ignore");

const SUPPORTED_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const DEFAULT_IGNORES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  "coverage",
]);

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function stripExt(p) {
  return p.replace(/\.(tsx?|jsx?)$/, "");
}

function hasImportExt(spec) {
  return /\.(tsx?|jsx?)$/.test(spec);
}

function isRelative(spec) {
  return spec.startsWith(".");
}

function parseArgs(argv) {
  const args = {
    root: null,
    write: false,
    dryRun: false,
    verbose: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--write") args.write = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--verbose") args.verbose = true;
    else if (!args.root) args.root = arg;
    else {
      console.error(`Unknown arg: ${arg}`);
      process.exit(1);
    }
  }

  if (!args.root) {
    console.error(
      "Usage: node scripts/shorten-imports.js <repoRoot> [--write] [--dry-run] [--verbose]",
    );
    process.exit(1);
  }

  if (args.write && args.dryRun) {
    console.error("Choose either --write or --dry-run (or neither).");
    process.exit(1);
  }

  return args;
}

function findNearestTsconfig(startDir, rootDir) {
  let current = startDir;
  const root = path.resolve(rootDir);
  while (true) {
    const candidate = path.join(current, "tsconfig.json");
    if (fs.existsSync(candidate)) return candidate;
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function loadTsconfig(tsconfigPath) {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    const message = ts.formatDiagnostic(configFile.error, {
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getCanonicalFileName: (f) => f,
      getNewLine: () => ts.sys.newLine,
    });
    throw new Error(message);
  }

  const basePath = path.dirname(tsconfigPath);
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    basePath,
    undefined,
    tsconfigPath,
  );

  return {
    basePath,
    options: parsed.options,
  };
}

function buildAliasMatchers(tsconfigPath, rootDir) {
  const { basePath, options } = loadTsconfig(tsconfigPath);
  const baseUrl = options.baseUrl
    ? path.resolve(basePath, options.baseUrl)
    : path.resolve(rootDir);
  const paths = options.paths || {};

  if (Object.keys(paths).length === 0) {
    return null;
  }

  const matchers = [];

  for (const [aliasPattern, targetPatterns] of Object.entries(paths)) {
    if (!Array.isArray(targetPatterns)) continue;
    for (const targetPattern of targetPatterns) {
      const alias = parseStarPattern(aliasPattern);
      const target = parseStarPattern(targetPattern);
      if (!alias || !target) continue;

      const targetPrefixAbs = path.resolve(baseUrl, target.prefix);
      const targetSuffix = target.suffix;

      matchers.push({
        aliasPrefix: alias.prefix,
        aliasSuffix: alias.suffix,
        targetPrefixAbs,
        targetSuffix,
        hasStar: alias.hasStar,
      });
    }
  }

  return { baseUrl, matchers };
}

function parseStarPattern(pattern) {
  const idx = pattern.indexOf("*");
  if (idx === -1) {
    return { prefix: pattern, suffix: "", hasStar: false };
  }
  const prefix = pattern.slice(0, idx);
  const suffix = pattern.slice(idx + 1);
  return { prefix, suffix, hasStar: true };
}

function buildAliasForTarget(targetAbs, matchers, keepExt) {
  const candidates = [];

  for (const m of matchers) {
    const targetPrefix = m.targetPrefixAbs;
    const targetSuffix = m.targetSuffix;

    if (!targetAbs.startsWith(targetPrefix)) continue;

    const remainder = targetAbs.slice(targetPrefix.length);
    if (targetSuffix && !remainder.endsWith(targetSuffix)) continue;

    const inner = targetSuffix
      ? remainder.slice(0, -targetSuffix.length)
      : remainder;

    const innerPosix = toPosix(inner).replace(/^\//, "");
    const aliasPath = `${m.aliasPrefix}${m.hasStar ? innerPosix : ""}${m.aliasSuffix}`;

    const finalAlias = keepExt ? aliasPath : stripExt(aliasPath);
    candidates.push(finalAlias);
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return candidates[0];
}

function loadGitignore(dir) {
  const gitignorePath = path.join(dir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) return null;
  if (!fs.statSync(gitignorePath).isFile()) return null;
  const contents = fs.readFileSync(gitignorePath, "utf8");
  const ig = ignore();
  ig.add(contents);
  return { baseDir: dir, ig };
}

function isIgnored(absPath, isDir, ignoreStack) {
  let ignored = false;
  for (const entry of ignoreStack) {
    let rel = path.relative(entry.baseDir, absPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    rel = toPosix(rel);
    if (isDir && !rel.endsWith("/")) rel += "/";
    const res = entry.ig.test(rel);
    if (res.ignored) ignored = true;
    if (res.unignored) ignored = false;
  }
  return ignored;
}

async function* walk(dir, ignoreStack) {
  const gitignore = loadGitignore(dir);
  const nextStack = gitignore ? ignoreStack.concat([gitignore]) : ignoreStack;

  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (DEFAULT_IGNORES.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const isDir = entry.isDirectory();
    if (isIgnored(fullPath, isDir, nextStack)) continue;

    if (isDir) {
      yield* walk(fullPath, nextStack);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (SUPPORTED_EXTS.has(ext)) {
        yield fullPath;
      }
    }
  }
}

function updateImportsInFile(filePath, tsconfigCache, rootDir) {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );

  let changed = false;
  const edits = new Map();

  const fileDir = path.dirname(filePath);
  const tsconfigPath = findNearestTsconfig(fileDir, rootDir);
  if (!tsconfigPath) return { changed: false, text: sourceText };

  let aliasInfo = tsconfigCache.get(tsconfigPath);
  if (!aliasInfo) {
    try {
      aliasInfo = buildAliasMatchers(tsconfigPath, rootDir);
    } catch (err) {
      throw new Error(`Failed to parse ${tsconfigPath}: ${err.message}`);
    }
    tsconfigCache.set(tsconfigPath, aliasInfo);
  }

  if (!aliasInfo) return { changed: false, text: sourceText };

  const { matchers } = aliasInfo;

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const moduleExpr = node.moduleSpecifier;
      if (moduleExpr && ts.isStringLiteral(moduleExpr)) {
        const spec = moduleExpr.text;
        if (isRelative(spec)) {
          const keepExt = hasImportExt(spec);
          const targetAbs = path.resolve(fileDir, spec);
          const bestAlias = buildAliasForTarget(targetAbs, matchers, keepExt);
          if (bestAlias && bestAlias.length < spec.length) {
            edits.set(moduleExpr.getStart(sourceFile) + 1, {
              start: moduleExpr.getStart(sourceFile) + 1,
              end: moduleExpr.getEnd() - 1,
              text: bestAlias,
            });
            changed = true;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (!changed) return { changed: false, text: sourceText };

  const sortedEdits = Array.from(edits.values()).sort(
    (a, b) => b.start - a.start,
  );
  let output = sourceText;
  for (const e of sortedEdits) {
    output = output.slice(0, e.start) + e.text + output.slice(e.end);
  }

  return { changed: true, text: output };
}

async function main() {
  const args = parseArgs(process.argv);
  const rootDir = path.resolve(args.root);

  console.log(`Scanning directory: ${rootDir}`);

  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    console.error(`Not a directory: ${rootDir}`);
    process.exit(1);
  }

  const tsconfigCache = new Map();
  let filesScanned = 0;
  let filesChanged = 0;
  const progressEvery = 200;

  for await (const file of walk(rootDir, [])) {
    filesScanned++;
    if (args.verbose) {
      console.log(`[scan] ${file}`);
    } else if (filesScanned % progressEvery === 0) {
      console.log(`[progress] scanned ${filesScanned} files...`);
    }
    const { changed, text } = updateImportsInFile(file, tsconfigCache, rootDir);
    if (changed) {
      filesChanged++;
      if (args.write) {
        fs.writeFileSync(file, text, "utf8");
      } else if (args.verbose || args.dryRun || !args.write) {
        console.log(`[change] ${file}`);
      }
    }
  }

  console.log(`Scanned ${filesScanned} files.`);
  if (args.write) {
    console.log(`Updated ${filesChanged} files.`);
  } else {
    console.log(`Would update ${filesChanged} files. Use --write to apply.`);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
