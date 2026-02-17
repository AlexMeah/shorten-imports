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
    postProcessUpdatedPathReferences: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--write") args.write = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--verbose") args.verbose = true;
    else if (arg === "--update-refs") {
      args.postProcessUpdatedPathReferences = true;
    } else if (!args.root) args.root = arg;
    else {
      console.error(`Unknown arg: ${arg}`);
      process.exit(1);
    }
  }

  if (!args.root) {
    console.error(
      "Usage: node scripts/shorten-imports.js <repoRoot> [--write] [--dry-run] [--verbose] [--update-refs]",
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

function isWithinRoot(rootDir, targetAbs) {
  const rel = path.relative(rootDir, targetAbs);
  if (!rel) return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function resolveExistingModulePath(targetAbs) {
  if (fs.existsSync(targetAbs)) return targetAbs;

  if (path.extname(targetAbs)) {
    return null;
  }

  for (const ext of SUPPORTED_EXTS) {
    const withExt = `${targetAbs}${ext}`;
    if (fs.existsSync(withExt)) return withExt;
  }

  for (const ext of SUPPORTED_EXTS) {
    const indexFile = path.join(targetAbs, `index${ext}`);
    if (fs.existsSync(indexFile)) return indexFile;
  }

  return null;
}

function getPackageNameFromSpecifier(spec) {
  if (!spec) return null;
  const parts = spec.split("/");
  if (spec.startsWith("@")) {
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] || null;
}

function hasNodeModulesPackage(packageName, startDir, rootDir, cache) {
  const cacheKey = `${startDir}::${packageName}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  let current = startDir;
  const root = path.resolve(rootDir);
  const packageSegments = packageName.split("/");
  let found = false;

  while (true) {
    const candidate = path.join(current, "node_modules", ...packageSegments);
    if (fs.existsSync(candidate)) {
      found = true;
      break;
    }
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  cache.set(cacheKey, found);
  return found;
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

function resolveBareAlias(spec, matchers, baseUrl, rootDir, keepExt) {
  const candidates = [];

  for (const m of matchers) {
    if (m.hasStar) {
      let innerTarget = spec;
      if (m.targetSuffix && innerTarget.endsWith(m.targetSuffix)) {
        innerTarget = innerTarget.slice(0, -m.targetSuffix.length);
      }
      const unresolvedTargetAbs = path.resolve(
        m.targetPrefixAbs,
        innerTarget + m.targetSuffix,
      );
      const resolvedTargetAbs = resolveExistingModulePath(unresolvedTargetAbs);
      if (!resolvedTargetAbs) continue;
      if (!isWithinRoot(rootDir, resolvedTargetAbs)) continue;

      const aliasPath = `${m.aliasPrefix}${spec}${m.aliasSuffix}`;
      const finalAlias = keepExt ? aliasPath : stripExt(aliasPath);
      candidates.push(finalAlias);
    } else {
      const unresolvedTargetAbs = path.resolve(
        m.targetPrefixAbs,
        m.targetSuffix,
      );
      const resolvedTargetAbs = resolveExistingModulePath(unresolvedTargetAbs);
      if (!resolvedTargetAbs) continue;
      if (!isWithinRoot(rootDir, resolvedTargetAbs)) continue;

      const targetRel = toPosix(path.relative(baseUrl, unresolvedTargetAbs));
      if (targetRel !== spec) continue;

      const aliasPath = `${m.aliasPrefix}${m.aliasSuffix}`;
      const finalAlias = keepExt ? aliasPath : stripExt(aliasPath);
      candidates.push(finalAlias);
    }
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

function updateImportsInFile(
  filePath,
  tsconfigCache,
  nodeModuleConflictCache,
  rootDir,
) {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );

  let changed = false;
  const edits = new Map();
  const updatedPathPairs = [];

  const fileDir = path.dirname(filePath);
  const tsconfigPath = findNearestTsconfig(fileDir, rootDir);
  if (!tsconfigPath) {
    return { changed: false, text: sourceText, updatedPathPairs };
  }

  let aliasInfo = tsconfigCache.get(tsconfigPath);
  if (!aliasInfo) {
    try {
      aliasInfo = buildAliasMatchers(tsconfigPath, rootDir);
    } catch (err) {
      throw new Error(`Failed to parse ${tsconfigPath}: ${err.message}`);
    }
    tsconfigCache.set(tsconfigPath, aliasInfo);
  }

  if (!aliasInfo) {
    return { changed: false, text: sourceText, updatedPathPairs };
  }

  const { matchers, baseUrl } = aliasInfo;
  const rootAbs = path.resolve(rootDir);
  const warnedNodeModuleConflicts = new Set();

  function queueModuleSpecifierRewrite(moduleExpr) {
    if (!moduleExpr || !ts.isStringLiteral(moduleExpr)) return;

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
        updatedPathPairs.push([spec, bestAlias]);
        changed = true;
      }
    } else {
      const keepExt = hasImportExt(spec);
      const bestAlias = resolveBareAlias(
        spec,
        matchers,
        baseUrl,
        rootAbs,
        keepExt,
      );
      if (bestAlias && bestAlias !== spec) {
        const packageName = getPackageNameFromSpecifier(spec);
        if (
          packageName &&
          hasNodeModulesPackage(
            packageName,
            fileDir,
            rootAbs,
            nodeModuleConflictCache,
          )
        ) {
          const warningKey = `${filePath}::${spec}`;
          if (!warnedNodeModuleConflicts.has(warningKey)) {
            console.warn(
              `[warn] Skipping bare import "${spec}" in ${filePath} because node_modules package "${packageName}" exists.`,
            );
            warnedNodeModuleConflicts.add(warningKey);
          }
          return;
        }

        edits.set(moduleExpr.getStart(sourceFile) + 1, {
          start: moduleExpr.getStart(sourceFile) + 1,
          end: moduleExpr.getEnd() - 1,
          text: bestAlias,
        });
        updatedPathPairs.push([spec, bestAlias]);
        changed = true;
      }
    }
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      queueModuleSpecifierRewrite(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const arg = node.arguments[0];
      queueModuleSpecifierRewrite(arg);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (!changed) return { changed: false, text: sourceText, updatedPathPairs };

  const sortedEdits = Array.from(edits.values()).sort(
    (a, b) => b.start - a.start,
  );
  let output = sourceText;
  for (const e of sortedEdits) {
    output = output.slice(0, e.start) + e.text + output.slice(e.end);
  }

  return { changed: true, text: output, updatedPathPairs };
}

function isImportExportModuleSpecifier(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) {
    return parent.moduleSpecifier === node;
  }
  return false;
}

function updatePathReferencesInFile(filePath, replacementMap) {
  if (replacementMap.size === 0) {
    return { changed: false, text: fs.readFileSync(filePath, "utf8") };
  }

  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );

  let changed = false;
  const edits = new Map();

  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isImportExportModuleSpecifier(node)) {
        const nextValue = replacementMap.get(node.text);
        if (nextValue && nextValue !== node.text) {
          edits.set(node.getStart(sourceFile) + 1, {
            start: node.getStart(sourceFile) + 1,
            end: node.getEnd() - 1,
            text: nextValue,
          });
          changed = true;
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

function buildStableReplacementMap(updatedPathMap) {
  const stableMap = new Map();
  const conflicts = [];

  for (const [fromPath, toPathSet] of updatedPathMap.entries()) {
    if (toPathSet.size === 1) {
      stableMap.set(fromPath, toPathSet.values().next().value);
    } else {
      conflicts.push(fromPath);
    }
  }

  return { stableMap, conflicts };
}

async function main() {
  const args = parseArgs(process.argv);
  const rootDir = path.resolve(args.root);

  console.log(`Scanning directory: ${rootDir}`);

  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    console.error(`Not a directory: ${rootDir}`);
    process.exit(1);
  }

  const postProcessUpdatedPathReferences =
    args.postProcessUpdatedPathReferences;

  const tsconfigCache = new Map();
  const nodeModuleConflictCache = new Map();
  let filesScanned = 0;
  let filesChanged = 0;
  let postProcessedFilesChanged = 0;
  const progressEvery = 200;
  const allSourceFiles = [];
  const updatedPathMap = new Map();

  for await (const file of walk(rootDir, [])) {
    filesScanned++;
    allSourceFiles.push(file);
    if (args.verbose) {
      console.log(`[scan] ${file}`);
    } else if (filesScanned % progressEvery === 0) {
      console.log(`[progress] scanned ${filesScanned} files...`);
    }
    const { changed, text, updatedPathPairs } = updateImportsInFile(
      file,
      tsconfigCache,
      nodeModuleConflictCache,
      rootDir,
    );
    for (const [fromPath, toPath] of updatedPathPairs) {
      let set = updatedPathMap.get(fromPath);
      if (!set) {
        set = new Set();
        updatedPathMap.set(fromPath, set);
      }
      set.add(toPath);
    }
    if (changed) {
      filesChanged++;
      if (args.write) {
        fs.writeFileSync(file, text, "utf8");
      } else if (args.verbose || args.dryRun || !args.write) {
        console.log(`[change] ${file}`);
      }
    }
  }

  if (postProcessUpdatedPathReferences && updatedPathMap.size > 0) {
    const { stableMap, conflicts } = buildStableReplacementMap(updatedPathMap);
    if (conflicts.length > 0) {
      console.warn(
        `Skipped ${conflicts.length} ambiguous path reference mapping(s) during post processing.`,
      );
      if (args.verbose) {
        for (const fromPath of conflicts) {
          const candidates = Array.from(updatedPathMap.get(fromPath)).sort();
          console.warn(`  ${fromPath} -> ${candidates.join(", ")}`);
        }
      }
    }

    for (const file of allSourceFiles) {
      const { changed, text } = updatePathReferencesInFile(file, stableMap);
      if (!changed) continue;

      postProcessedFilesChanged++;
      if (args.write) {
        fs.writeFileSync(file, text, "utf8");
      } else if (args.verbose || args.dryRun || !args.write) {
        console.log(`[post-change] ${file}`);
      }
    }
  }

  console.log(`Scanned ${filesScanned} files.`);
  if (args.write) {
    console.log(`Updated ${filesChanged} files.`);
    if (postProcessUpdatedPathReferences) {
      console.log(`Post-processed ${postProcessedFilesChanged} files.`);
    }
  } else {
    console.log(`Would update ${filesChanged} files. Use --write to apply.`);
    if (postProcessUpdatedPathReferences) {
      console.log(
        `Would post-process ${postProcessedFilesChanged} files. Use --write to apply.`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
