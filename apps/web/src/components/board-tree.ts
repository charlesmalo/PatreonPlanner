import type { Recommendation } from '../api/types';

export interface TreeNode {
  item: Recommendation;
  children: TreeNode[];
}

/**
 * Groups a column's entries into a tree by `parentId`.
 *
 * Defensive on purpose. The API only ever produces one level today, but rendering just roots and
 * their direct children *dropped* anything deeper, and a cycle left no roots at all and made the
 * whole column disappear. Losing entries is far worse than rendering them flat, so anything the
 * walk cannot place is promoted to the top level.
 */
export function buildTree(items: Recommendation[]): TreeNode[] {
  const nodes = new Map(items.map((item) => [item.id, { item, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];

  for (const node of nodes.values()) {
    const parent = node.item.parentId ? nodes.get(node.item.parentId) : undefined;
    // A parent outside this column, or a cycle, means this entry stands on its own.
    if (parent && parent !== node && !descendsFrom(parent, node, nodes)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function descendsFrom(
  candidate: TreeNode,
  ancestor: TreeNode,
  nodes: Map<string, TreeNode>,
): boolean {
  const seen = new Set<string>();
  let current: TreeNode | undefined = candidate;
  while (current && !seen.has(current.item.id)) {
    if (current === ancestor) return true;
    seen.add(current.item.id);
    current = current.item.parentId ? nodes.get(current.item.parentId) : undefined;
  }
  return false;
}
