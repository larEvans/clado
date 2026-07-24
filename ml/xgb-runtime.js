/**
 * ml/xgb-runtime.js — evaluate a trained XGBoost booster in pure JS.
 *
 * We train with real XGBoost in Python (ml/train.py) but we DON'T want a Python
 * process in the live trading path. Instead train.py exports the booster as a
 * plain JSON tree dump (`booster.get_dump(dump_format="json")`) into model.json,
 * and this module walks those trees at inference time. The result is
 * bit-for-bit the same margin XGBoost would produce for `reg:squarederror`.
 *
 * A single tree node from XGBoost's JSON dump looks like:
 *   { "nodeid":0, "split":"f2", "split_condition":1.5,
 *     "yes":1, "no":2, "missing":1, "children":[ {...}, {...} ] }
 * Leaves look like: { "nodeid":3, "leaf":0.0123 }
 *
 * Decision rule (XGBoost default): take the `yes` branch when
 * feature < split_condition, else `no`; NaN/undefined go to `missing`.
 */

/** Build a fast nodeid → node lookup for one tree (dump gives nested children). */
function indexTree(root) {
  const byId = new Map();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    byId.set(node.nodeid, node);
    if (node.children) for (const c of node.children) stack.push(c);
  }
  return byId;
}

/** Precompute per-tree node maps and resolve "fN" split names to indices. */
export function compileModel(model) {
  const nameToIdx = new Map((model.feature_names || []).map((n, i) => [n, i]));
  const resolveFeat = (split) => {
    if (typeof split === "number") return split;
    if (nameToIdx.has(split)) return nameToIdx.get(split);
    const m = /^f(\d+)$/.exec(split);       // XGBoost's default "f0","f1",… naming
    return m ? Number(m[1]) : -1;
  };
  const trees = (model.trees || []).map(root => ({ root, byId: indexTree(root), resolveFeat }));
  return {
    trees,
    baseScore: Number(model.base_score ?? 0.5),
    featureCount: (model.feature_names || []).length,
  };
}

/** Score one leaf value for a single tree given the feature vector. */
function evalTree(tree, features) {
  let node = tree.root;
  while (node && node.leaf === undefined) {
    const idx = tree.resolveFeat(node.split);
    const val = idx >= 0 ? features[idx] : NaN;
    let nextId;
    if (val === undefined || val === null || Number.isNaN(val)) {
      nextId = node.missing;
    } else {
      nextId = val < node.split_condition ? node.yes : node.no;
    }
    node = tree.byId.get(nextId);
  }
  return node ? node.leaf : 0;
}

/**
 * Raw margin = base_score + Σ leaf values. For reg:squarederror this is the
 * predicted value directly (no link function).
 */
export function predictRaw(compiled, features) {
  let sum = compiled.baseScore;
  for (const tree of compiled.trees) sum += evalTree(tree, features);
  return sum;
}
