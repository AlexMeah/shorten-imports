# Shorten Imports CLI

A local Node.js CLI that scans a repo and rewrites relative imports/exports to the **shortest** alias path based on `tsconfig` `baseUrl` + `paths`.

Example:

```
../../../components/Hello.tsx  ->  @/components/Hello.tsx
```

## Features

- Resolves **full absolute paths** to preserve nested hierarchies.
- Uses the **nearest `tsconfig.json`** for each file (walks up from the file’s directory).
- Supports `ts/tsx/js/jsx` files.
- Skips common build folders and respects `.gitignore` (including nested `.gitignore`).
- Only rewrites when the alias path is **shorter** than the relative path.

## Setup

```
npm install
```

## Global Install (Optional)

If you want to run it from anywhere:

```
npm install -g .
shorten-imports /path/to/repo --dry-run
shorten-imports /path/to/repo --write
```

## Usage

```
node scripts/shorten-imports.js <repoRoot> [--write] [--dry-run] [--verbose]
```

Examples:

```
node scripts/shorten-imports.js /path/to/repo --dry-run
node scripts/shorten-imports.js /path/to/repo --write
```

## Notes

- Requires `compilerOptions.paths` in the relevant `tsconfig.json`.
- If `compilerOptions.baseUrl` is missing, the CLI defaults it to the provided repo root.
- If multiple aliases match, the CLI chooses the **shortest** alias path.
- If the original import includes an extension, the alias keeps it.

## Limitations

- Does not rewrite non-relative module specifiers (e.g. `@/foo` or `react`).
- Only processes files reachable from the provided repo root.
