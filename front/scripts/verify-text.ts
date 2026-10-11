/**
 * No user-facing literal outside `src/text/` (TRE-116).
 *
 * Copy lives in `src/text/en/<zone>.ts` and is reached through
 * `useTranslations`. This refuses the places copy shows up when someone forgets:
 *
 *   - JSX text with a word in it;
 *   - a string in a JSX child expression (`{ok ? "saved" : "failed"}`);
 *   - a string given to a prop that carries copy (`aria-label`, `title`,
 *     `placeholder`, a tooltip's `content`…);
 *   - a string in an object field that carries copy (`label`, `note`,
 *     `message`, `detail`…) — toasts, menu rows, the action registry;
 *   - a validation message handed to zod in `src/schemas/`.
 *
 * Read with the TypeScript parser rather than a regex, so a class name, a sort
 * key or a `KeyboardEvent.key` in any other position is not a finding: those are
 * wire format, not copy. A string that has to stay where it is carries a
 * `// verify-text: <reason>` comment on the line above, and the reason is the
 * review.
 *
 * Runs from `pnpm test`, which the deploy gate runs — a guard nothing invokes
 * is a comment.
 *
 *   node scripts/verify-text.ts        (or: pnpm verify:text)
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const front = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(front, "src");

/** Where copy is allowed to be, and where the machinery that reads it lives. */
const EXEMPT_DIRS = [join(src, "text"), join(src, "i18n")];

/** JSX props whose value is read by a person. */
const COPY_PROPS = new Set([
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "alt",
  "title",
  "placeholder",
  "label",
  "content",
  "message",
  "detail",
  "description",
  "hint",
  "heading",
  "caption",
  "confirmLabel",
  "cancelLabel",
  "emptyText",
]);

/** Object fields whose value is read by a person. */
const COPY_FIELDS = new Set([
  "label",
  "short",
  "note",
  "hint",
  "message",
  "detail",
  "title",
  "description",
  "placeholder",
  "reason",
  "unavailableReason",
  "heading",
  "caption",
  "error",
]);

/** zod refinements whose string argument is the message shown under a field. */
const ZOD_MESSAGES = new Set([
  "min",
  "max",
  "length",
  "email",
  "url",
  "regex",
  "refine",
  "superRefine",
  "nonempty",
  "startsWith",
  "endsWith",
  "int",
  "positive",
  "nonnegative",
  "includes",
]);

const ALLOW = "verify-text:";

/** A word, not a glyph or a unit letter: two letters in a row. */
const WORDY = /[A-Za-z]{2,}/;

interface Finding {
  file: string;
  line: number;
  text: string;
}

function walk(directory: string, into: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!EXEMPT_DIRS.includes(path)) walk(path, into);
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec)\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      into.push(path);
    }
  }
}

/** The literal parts of a string or template, joined — what a reader would see of it. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("…");
  }
  return null;
}

/**
 * Strings an expression can evaluate to, through the shapes copy is written in:
 * a ternary, `a ?? b`, `a || b`, parentheses. Anything else is a value computed
 * elsewhere, and elsewhere is where it gets checked.
 */
function candidates(node: ts.Expression): ts.Node[] {
  if (ts.isParenthesizedExpression(node)) return candidates(node.expression);
  if (ts.isConditionalExpression(node)) return [...candidates(node.whenTrue), ...candidates(node.whenFalse)];
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (
      operator === ts.SyntaxKind.QuestionQuestionToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      return [...candidates(node.left), ...candidates(node.right)];
    }
    if (operator === ts.SyntaxKind.PlusToken) return [...candidates(node.left), ...candidates(node.right)];
    return [];
  }
  return literalText(node) === null ? [] : [node];
}

function allowed(source: ts.SourceFile, node: ts.Node): boolean {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  const lines = source.text.split("\n");
  // The line itself (a trailing comment) or any of the three above it — a JSX
  // attribute's comment sits above the element, not the prop.
  for (let at = line; at >= Math.max(0, line - 3); at -= 1) {
    if (lines[at]?.includes(ALLOW)) return true;
  }
  return false;
}

function propName(name: ts.PropertyName | ts.JsxAttributeName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isJsxNamespacedName(name)) return `${name.namespace.text}:${name.name.text}`;
  return null;
}

function scan(path: string): Finding[] {
  const text = readFileSync(path, "utf8");
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const inSchemas = path.startsWith(join(src, "schemas"));
  const found: Finding[] = [];

  const report = (node: ts.Node, shown: string): void => {
    if (!WORDY.test(shown) || allowed(source, node)) return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push({ file: relative(front, path), line: line + 1, text: shown.trim().replace(/\s+/g, " ").slice(0, 70) });
  };

  const reportAll = (expression: ts.Expression): void => {
    for (const node of candidates(expression)) report(node, literalText(node) ?? "");
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      report(node, node.text);
    } else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      reportAll(node.expression);
    } else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = propName(node.name);
      if (name !== null && COPY_PROPS.has(name)) {
        if (ts.isStringLiteral(node.initializer)) report(node.initializer, node.initializer.text);
        else if (ts.isJsxExpression(node.initializer) && node.initializer.expression)
          reportAll(node.initializer.expression);
      }
    } else if (ts.isPropertyAssignment(node)) {
      const name = propName(node.name);
      if (name !== null && COPY_FIELDS.has(name)) reportAll(node.initializer);
    } else if (inSchemas && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (ZOD_MESSAGES.has(node.expression.name.text)) {
        for (const argument of node.arguments) reportAll(argument);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

const files: string[] = [];
walk(src, files);
const findings = files.flatMap(scan);

if (findings.length === 0) {
  console.log(`ok — no user-facing literal in ${files.length} files outside src/text`);
} else {
  for (const finding of findings) console.log(`${finding.file}:${finding.line}  ${JSON.stringify(finding.text)}`);
  const perFile = new Set(findings.map((finding) => finding.file)).size;
  console.log(`\n${findings.length} literals in ${perFile} files — move them to src/text/en/<zone>.ts`);
  console.log(`(a string that must stay carries a "// ${ALLOW} <reason>" comment on the line above)`);
  process.exit(1);
}
