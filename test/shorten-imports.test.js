"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const CLI_PATH = path.resolve(__dirname, "..", "scripts", "shorten-imports.js");

function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shorten-imports-"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function readFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function runCli(rootDir, args) {
  execFileSync(process.execPath, [CLI_PATH, rootDir, ...args], {
    stdio: "pipe",
  });
}

test("rewrites to the shortest alias using tsconfig paths", () => {
  const root = mkdtemp();

  writeJson(path.join(root, "tsconfig.json"), {
    compilerOptions: {
      baseUrl: ".",
      paths: {
        "@/*": ["src/*"],
      },
    },
  });

  writeFile(
    path.join(root, "src", "components", "Hello.tsx"),
    "export default function Hello() { return null; }\n",
  );

  const targetFile = path.join(root, "src", "pages", "foo", "bar", "Baz.tsx");
  writeFile(
    targetFile,
    [
      'import Hello from "../../../components/Hello.tsx";',
      "export default function Baz() { return <Hello />; }",
      "",
    ].join("\n"),
  );

  runCli(root, ["--write"]);

  const updated = readFile(targetFile);
  assert.match(updated, /from \"@\/components\/Hello\.tsx\"/);
});

test("uses nearest tsconfig.json for nested directories", () => {
  const root = mkdtemp();

  writeJson(path.join(root, "tsconfig.json"), {
    compilerOptions: {
      baseUrl: ".",
      paths: {
        "@/*": ["src/*"],
      },
    },
  });

  writeJson(path.join(root, "src", "feature", "tsconfig.json"), {
    compilerOptions: {
      baseUrl: ".",
      paths: {
        "~/*": ["*"],
      },
    },
  });

  writeFile(
    path.join(root, "src", "feature", "components", "Widget.tsx"),
    "export const Widget = () => null;\n",
  );

  const targetFile = path.join(root, "src", "feature", "pages", "Thing.tsx");
  writeFile(
    targetFile,
    [
      'import { Widget } from "../components/Widget.tsx";',
      "export default function Thing() { return <Widget />; }",
      "",
    ].join("\n"),
  );

  runCli(root, ["--write"]);

  const updated = readFile(targetFile);
  assert.match(updated, /from \"~\/components\/Widget\.tsx\"/);
});

test("respects .gitignore (ignored folders are not processed)", () => {
  const root = mkdtemp();

  writeJson(path.join(root, "tsconfig.json"), {
    compilerOptions: {
      baseUrl: ".",
      paths: {
        "@/*": ["src/*"],
      },
    },
  });

  writeFile(path.join(root, ".gitignore"), "ignored/\n");

  writeFile(
    path.join(root, "src", "components", "A.tsx"),
    "export const A = () => null;\n",
  );

  const ignoredFile = path.join(root, "ignored", "Bad.tsx");
  writeFile(
    ignoredFile,
    [
      'import { A } from "../src/components/A.tsx";',
      "export const Bad = () => <A />;",
      "",
    ].join("\n"),
  );

  runCli(root, ["--write"]);

  const updated = readFile(ignoredFile);
  assert.match(updated, /from \"\.\.\/src\/components\/A\.tsx\"/);
});

test("defaults baseUrl to repo root when missing", () => {
  const root = mkdtemp();

  writeJson(path.join(root, "tsconfig.json"), {
    compilerOptions: {
      paths: {
        "@/*": ["./src/*"],
      },
    },
  });

  writeFile(
    path.join(root, "src", "components", "Thing.tsx"),
    "export const Thing = () => null;\n",
  );

  const targetFile = path.join(root, "src", "pages", "Page.tsx");
  writeFile(
    targetFile,
    [
      'import { Thing } from "../components/Thing.tsx";',
      "export default function Page() { return <Thing />; }",
      "",
    ].join("\n"),
  );

  runCli(root, ["--write"]);

  const updated = readFile(targetFile);
  assert.match(updated, /from \"@\/components\/Thing\.tsx\"/);
});

test("does rewrite bare module specifiers", () => {
  const root = mkdtemp();

  writeJson(path.join(root, "tsconfig.json"), {
    compilerOptions: {
      baseUrl: ".",
      paths: {
        "@/*": ["src/*"],
      },
    },
  });

  writeFile(
    path.join(root, "src", "components", "Thing.tsx"),
    "export const Thing = () => null;\n",
  );

  const targetFile = path.join(root, "src", "pages", "Page.tsx");
  const original = [
    'import { Thing } from "components/Thing.tsx";',
    'import React from "react";',
    "export default function Page() { return <Thing />; }",
    "",
  ].join("\n");
  writeFile(targetFile, original);

  runCli(root, ["--write"]);

  const updated = readFile(targetFile);
  assert.match(updated, /from \"@\/components\/Thing\.tsx\"/);
});

test("does not post-process exact path references by default", () => {
  const root = mkdtemp();

  writeJson(path.join(root, "tsconfig.json"), {
    compilerOptions: {
      baseUrl: ".",
      paths: {
        "@/*": ["src/*"],
      },
    },
  });

  writeFile(
    path.join(root, "src", "components", "CompanyAdminRoute.tsx"),
    "export const CompanyAdminRoute = () => null;\n",
  );

  const importerFile = path.join(root, "src", "pages", "Page.tsx");
  writeFile(
    importerFile,
    [
      'import { CompanyAdminRoute } from "components/CompanyAdminRoute";',
      "export default function Page() { return <CompanyAdminRoute />; }",
      "",
    ].join("\n"),
  );

  const jestFile = path.join(root, "src", "pages", "Page.test.tsx");
  writeFile(
    jestFile,
    [
      'jest.mock("components/CompanyAdminRoute", () => ({',
      "  CompanyAdminRoute: () => null,",
      "}));",
      "",
    ].join("\n"),
  );

  runCli(root, ["--write"]);

  const importerUpdated = readFile(importerFile);
  assert.match(importerUpdated, /from \"@\/components\/CompanyAdminRoute\"/);

  const jestUpdated = readFile(jestFile);
  assert.match(jestUpdated, /jest\.mock\(\"components\/CompanyAdminRoute\"/);
});

test("post-processes exact path references when enabled via CLI arg", () => {
  const root = mkdtemp();

  writeJson(path.join(root, "tsconfig.json"), {
    compilerOptions: {
      baseUrl: ".",
      paths: {
        "@/*": ["src/*"],
      },
    },
  });

  writeFile(
    path.join(root, "src", "components", "CompanyAdminRoute.tsx"),
    "export const CompanyAdminRoute = () => null;\n",
  );

  writeFile(
    path.join(root, "src", "pages", "Page.tsx"),
    [
      'import { CompanyAdminRoute } from "components/CompanyAdminRoute";',
      "export default function Page() { return <CompanyAdminRoute />; }",
      "",
    ].join("\n"),
  );

  const jestFile = path.join(root, "src", "pages", "Page.test.tsx");
  writeFile(
    jestFile,
    [
      'jest.mock("components/CompanyAdminRoute", () => ({',
      "  CompanyAdminRoute: () => null,",
      "}));",
      "",
    ].join("\n"),
  );

  runCli(root, ["--write", "--update-refs"]);

  const jestUpdated = readFile(jestFile);
  assert.match(jestUpdated, /jest\.mock\(\"@\/components\/CompanyAdminRoute\"/);
});

test("rewrites dynamic import() paths and post-processes matching jest.mock references", () => {
  const root = mkdtemp();

  writeJson(path.join(root, "tsconfig.json"), {
    compilerOptions: {
      baseUrl: ".",
      paths: {
        "@/*": ["src/*"],
      },
    },
  });

  writeFile(
    path.join(root, "src", "components", "CompanyAdminRoute.tsx"),
    "export default function CompanyAdminRoute() { return null; }\n",
  );

  const appFile = path.join(root, "src", "App.tsx");
  writeFile(
    appFile,
    [
      "const CompanyAdminRoute = lazy(",
      '  () => import("components/CompanyAdminRoute"),',
      ");",
      "",
    ].join("\n"),
  );

  const specFile = path.join(root, "src", "App.spec.tsx");
  writeFile(
    specFile,
    [
      'jest.mock("components/CompanyAdminRoute", () => ({',
      "  __esModule: true,",
      "  default: () => null,",
      "}));",
      "",
    ].join("\n"),
  );

  runCli(root, ["--write", "--update-refs"]);

  const appUpdated = readFile(appFile);
  assert.match(appUpdated, /import\(\"@\/components\/CompanyAdminRoute\"\)/);

  const specUpdated = readFile(specFile);
  assert.match(specUpdated, /jest\.mock\(\"@\/components\/CompanyAdminRoute\"/);
});
