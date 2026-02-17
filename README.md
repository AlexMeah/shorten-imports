# Shorten Imports CLI

A local Node.js CLI that scans a repo and rewrites relative imports/exports to the **shortest** alias path based on `tsconfig` `baseUrl` + `paths`.

Example:

```
../../../components/Hello.tsx  ->  @/components/Hello.tsx
```

## Features

- Resolves **full absolute paths** to preserve nested hierarchies.
- Uses the **nearest `tsconfig.json`** for each file (walks up from the file’s directory).
- Rewrites module paths in `import`/`export` declarations and dynamic `import()` calls.
- Supports `ts/tsx/js/jsx` files.
- Skips common build folders and respects `.gitignore` (including nested `.gitignore`).
- Only rewrites when the alias path is **shorter** than the relative path.
- Optional post-processing step that updates exact string literal references using collected old->new path rewrites (for example `jest.mock("components/X")`).

## Install

Install from npm to run it from anywhere:

```
npm install -g shorten-imports
```

## Usage

```
shorten-imports <repoRoot> [--write] [--dry-run] [--verbose] [--update-refs]
```

Examples:

```
shorten-imports /path/to/repo --dry-run
shorten-imports /path/to/repo --write
shorten-imports /path/to/repo --write --update-refs
```

## Notes

- Requires `compilerOptions.paths` in the relevant `tsconfig.json`.
- If `compilerOptions.baseUrl` is missing, the CLI defaults it to the provided repo root.
- If multiple aliases match, the CLI chooses the **shortest** alias path.
- If the original import includes an extension, the alias keeps it.
- Post-processing only applies unambiguous mappings (`oldPath` mapped to exactly one `newPath`).

## Limitations

- Does not rewrite already-short aliased module specifiers (e.g. `@/foo`) or package imports (e.g. `react`).
- Only processes files reachable from the provided repo root.
