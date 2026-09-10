/**
 * Odoo Framework Resolver
 *
 * Bridges Odoo's `_name`/`_inherit` model-merging mechanism into real graph
 * edges. An Odoo module extends a model by declaring a brand new Python
 * class elsewhere in the codebase with `_inherit = "model.name"` — there is
 * no Python import between the extending class and the model's original
 * definer, so this dispatch is invisible to normal tree-sitter extraction
 * (the exact "dynamic dispatch" gap this resolver layer exists to close).
 *
 * Scope (basic / first cut):
 *   - Links each `_inherit`-ing class to the class that *created* the model
 *     (`_name = "model.name"`), or — when no creator is indexed (e.g. a core
 *     Odoo model whose source isn't part of this project) — to another
 *     indexed class that also extends it, so the chain still connects.
 *   - `_inherits` (delegation/composition, e.g. `_inherits = {"res.partner":
 *     "partner_id"}`) is a different mechanism (not class merging) and is
 *     out of scope here.
 *   - Regex/line-based scanning (like every other framework resolver here),
 *     not a real Python parser — multi-line `_inherit = [...]` lists are not
 *     matched (single-line lists and bare strings are).
 */

import { FrameworkExtractionResult, FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';
import { generateNodeId } from '../../extraction/tree-sitter-helpers';
import { stripCommentsForRegex } from '../strip-comments';

// Odoo model base classes, matched by bare name so both `models.Model` and a
// `from odoo.models import Model` bare `Model` base are recognised.
const ODOO_BASE_CLASSES = new Set(['Model', 'TransientModel', 'AbstractModel']);

// Odoo model technical names are always dotted lower_snake_case, e.g.
// "sale.order", "res.partner", "mail.thread". No indexed node is ever named
// after a model (only after Python class identifiers), so this pattern is
// what lets `_inherit` reference strings past the resolver's fast
// name-existence pre-filter via `claimsReference`.
const ODOO_MODEL_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

const CLASS_HEADER = /^([ \t]*)class\s+(\w+)\s*\(([^)]*)\)\s*:/;
const NAME_ASSIGN = /_name\s*=\s*['"]([^'"]+)['"]/;
const INHERIT_STRING_ASSIGN = /_inherit\s*=\s*['"]([^'"]+)['"]/;
const INHERIT_LIST_ASSIGN = /_inherit\s*=\s*\[([^\]]*)\]/;
const QUOTED = /['"]([^'"]+)['"]/g;

interface OdooClassInfo {
  /** Python class identifier, e.g. "SaleOrder". */
  name: string;
  /** 1-indexed line of the `class` keyword — matches tree-sitter's node.startLine. */
  line: number;
  /** Model this class creates (`_name = "..."`), or null. */
  modelName: string | null;
  /** Models this class extends (`_inherit = "..."` / `_inherit = [...]`). */
  inherits: string[];
}

function indentWidth(prefix: string): number {
  return prefix.replace(/\t/g, '    ').length;
}

function isOdooBaseClause(basesText: string): boolean {
  for (const m of basesText.matchAll(/\w+/g)) {
    if (ODOO_BASE_CLASSES.has(m[0])) return true;
  }
  return false;
}

/**
 * Scan Python source for Odoo model classes and their `_name`/`_inherit`
 * declarations. Shared by `extract` (per-file, no graph access) and the
 * project-wide model index built lazily at resolve time.
 */
function scanOdooClasses(content: string): OdooClassInfo[] {
  const safe = stripCommentsForRegex(content, 'python');
  const lines = safe.split('\n');
  const classes: OdooClassInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const header = CLASS_HEADER.exec(lines[i]!);
    if (!header) continue;
    const [, indentStr, className, basesText] = header;
    if (!isOdooBaseClause(basesText!)) continue;

    const classIndent = indentWidth(indentStr!);
    let modelName: string | null = null;
    const inherits: string[] = [];

    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() === '') continue;
      if (indentWidth(/^[ \t]*/.exec(line)![0]) <= classIndent) break; // dedent: class body ended

      const nameMatch = NAME_ASSIGN.exec(line);
      if (nameMatch) modelName = nameMatch[1]!;

      const inheritStr = INHERIT_STRING_ASSIGN.exec(line);
      if (inheritStr) {
        inherits.push(inheritStr[1]!);
      } else {
        const inheritList = INHERIT_LIST_ASSIGN.exec(line);
        if (inheritList) {
          for (const q of inheritList[1]!.matchAll(QUOTED)) inherits.push(q[1]!);
        }
      }
    }

    classes.push({ name: className!, line: i + 1, modelName, inherits });
  }

  return classes;
}

interface OdooModelEntry {
  /** Node ids of classes declaring `_name` == this model (usually one). */
  creators: string[];
  /** Node ids of classes declaring `_inherit` == this model, in scan order. */
  extenders: string[];
}

const odooModelIndexCache = new WeakMap<ResolutionContext, Map<string, OdooModelEntry>>();

function entryFor(index: Map<string, OdooModelEntry>, model: string): OdooModelEntry {
  let entry = index.get(model);
  if (!entry) {
    entry = { creators: [], extenders: [] };
    index.set(model, entry);
  }
  return entry;
}

function buildOdooModelIndex(context: ResolutionContext): Map<string, OdooModelEntry> {
  const index = new Map<string, OdooModelEntry>();

  for (const filePath of context.getAllFiles()) {
    if (!filePath.endsWith('.py')) continue;
    const content = context.readFile(filePath);
    if (!content) continue;

    for (const cls of scanOdooClasses(content)) {
      const nodeId = generateNodeId(filePath, 'class', cls.name, cls.line);
      if (cls.modelName) entryFor(index, cls.modelName).creators.push(nodeId);
      for (const target of cls.inherits) {
        if (target === cls.modelName) continue; // guard against a literal self-reference
        entryFor(index, target).extenders.push(nodeId);
      }
    }
  }

  return index;
}

function getCachedOdooModelIndex(context: ResolutionContext): Map<string, OdooModelEntry> {
  const cached = odooModelIndexCache.get(context);
  if (cached) return cached;
  const index = buildOdooModelIndex(context);
  odooModelIndexCache.set(context, index);
  return index;
}

export const odooResolver: FrameworkResolver = {
  name: 'odoo',
  languages: ['python'],

  detect(context: ResolutionContext): boolean {
    return context.getAllFiles().some((f) => f.endsWith('__manifest__.py') || f.endsWith('__openerp__.py'));
  },

  claimsReference(name: string): boolean {
    return ODOO_MODEL_NAME.test(name);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.referenceKind !== 'extends' || ref.language !== 'python') return null;

    const index = getCachedOdooModelIndex(context);
    const entry = index.get(ref.referenceName);
    if (!entry) return null;

    const targetId = entry.creators.find((id) => id !== ref.fromNodeId)
      ?? entry.extenders.find((id) => id !== ref.fromNodeId);
    if (!targetId) return null;

    return { original: ref, targetNodeId: targetId, confidence: 0.85, resolvedBy: 'framework' };
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    if (!filePath.endsWith('.py')) return { nodes: [], references: [] };

    const references: UnresolvedRef[] = [];
    for (const cls of scanOdooClasses(content)) {
      if (cls.inherits.length === 0) continue;
      const fromNodeId = generateNodeId(filePath, 'class', cls.name, cls.line);
      for (const target of cls.inherits) {
        references.push({
          fromNodeId,
          referenceName: target,
          referenceKind: 'extends',
          line: cls.line,
          column: 0,
          filePath,
          language: 'python',
        });
      }
    }

    return { nodes: [], references };
  },
};
