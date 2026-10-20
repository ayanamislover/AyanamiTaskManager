//! 依赖图与父子层级的校验（01 W-004、W-006、W-076）。纯函数：调用方读出整个项目的图（再叠上本次的改动）传进来。

use std::collections::{HashMap, HashSet};

/// W-006：层级上限（根深度为 1）。
pub(crate) const MAX_DEPTH: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GraphError {
    /// DEPENDENCY_CYCLE / SELF_DEPENDENCY
    SelfDependency,
    /// DEPENDENCY_CYCLE / REACHES_TASK
    ReachesTask,
    /// HIERARCHY_CYCLE / SELF_PARENT
    SelfParent,
    /// HIERARCHY_CYCLE / PARENT_IS_DESCENDANT
    ParentIsDescendant,
    /// HIERARCHY_CYCLE / EXISTING_CYCLE
    ExistingCycle,
    /// HIERARCHY_DEPTH
    TooDeep { prospective_depth: usize },
}

impl GraphError {
    pub fn reason(self) -> &'static str {
        match self {
            GraphError::SelfDependency => "SELF_DEPENDENCY",
            GraphError::ReachesTask => "REACHES_TASK",
            GraphError::SelfParent => "SELF_PARENT",
            GraphError::ParentIsDescendant => "PARENT_IS_DESCENDANT",
            GraphError::ExistingCycle => "EXISTING_CYCLE",
            GraphError::TooDeep { .. } => "HIERARCHY_DEPTH",
        }
    }
}

/// W-004 `assert_acyclic(task, dep)`：`prereqs[x]` 是 x 的全部 BLOCKS 前置。从 dep 沿「我的前置」方向走，
/// 走到 task 就成环；task == dep 是自依赖。
pub(crate) fn dependency_ok(
    task: &str,
    dep: &str,
    prereqs: &HashMap<String, Vec<String>>,
) -> Result<(), GraphError> {
    if task == dep {
        return Err(GraphError::SelfDependency);
    }
    let mut seen: HashSet<&str> = HashSet::new();
    let mut stack = vec![dep];
    while let Some(x) = stack.pop() {
        if x == task {
            return Err(GraphError::ReachesTask);
        }
        if !seen.insert(x) {
            continue;
        }
        if let Some(next) = prereqs.get(x) {
            stack.extend(next.iter().map(String::as_str));
        }
    }
    Ok(())
}

/// W-006 `assert_parent_move(item, parent)`：`parents[x]` 是 x 的父（没有就不在表里）。
/// 深度 = parent 到根的节点数 + item 子树高度，超过 8 拒绝。
pub(crate) fn parent_ok(
    item: &str,
    parent: &str,
    parents: &HashMap<String, String>,
) -> Result<(), GraphError> {
    if item == parent {
        return Err(GraphError::SelfParent);
    }
    let mut seen: HashSet<&str> = HashSet::new();
    let mut depth = 0usize;
    let mut cursor = Some(parent);
    while let Some(x) = cursor {
        if x == item {
            return Err(GraphError::ParentIsDescendant);
        }
        if !seen.insert(x) {
            return Err(GraphError::ExistingCycle);
        }
        depth += 1;
        cursor = parents.get(x).map(String::as_str);
    }
    let prospective_depth = depth + subtree_height(item, parents);
    if prospective_depth > MAX_DEPTH {
        return Err(GraphError::TooDeep { prospective_depth });
    }
    Ok(())
}

/// item 自己算 1 层。
fn subtree_height(item: &str, parents: &HashMap<String, String>) -> usize {
    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    for (child, parent) in parents {
        children
            .entry(parent.as_str())
            .or_default()
            .push(child.as_str());
    }
    let mut best = 0usize;
    let mut stack = vec![(item, 1usize)];
    let mut seen: HashSet<&str> = HashSet::new();
    while let Some((x, h)) = stack.pop() {
        if !seen.insert(x) {
            continue;
        }
        best = best.max(h);
        if let Some(kids) = children.get(x) {
            stack.extend(kids.iter().map(|k| (*k, h + 1)));
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
            .collect()
    }

    #[test]
    fn w006_depth_counts_the_moved_subtree() {
        // R(1) ← A(2) ← … ← G(8)：链长 8。
        let chain = map(&[
            ("A", "R"),
            ("B", "A"),
            ("C", "B"),
            ("D", "C"),
            ("E", "D"),
            ("F", "E"),
            ("G", "F"),
        ]);
        assert_eq!(parent_ok("X", "F", &chain), Ok(()));
        assert_eq!(
            parent_ok("X", "G", &chain),
            Err(GraphError::TooDeep {
                prospective_depth: 9
            })
        );
        // 带一个两层子树挂到第 7 层下：7 + 2 = 9。
        let mut with_kid = chain.clone();
        with_kid.insert("Y".into(), "X".into());
        assert_eq!(
            parent_ok("X", "F", &with_kid),
            Err(GraphError::TooDeep {
                prospective_depth: 9
            })
        );
        assert_eq!(
            parent_ok("R", "C", &chain),
            Err(GraphError::ParentIsDescendant)
        );
        assert_eq!(parent_ok("A", "A", &chain), Err(GraphError::SelfParent));
        let cyclic = map(&[("P", "Q"), ("Q", "P")]);
        assert_eq!(parent_ok("X", "P", &cyclic), Err(GraphError::ExistingCycle));
    }

    #[test]
    fn w004_cycles_are_found_through_prerequisites() {
        let mut prereqs: HashMap<String, Vec<String>> = HashMap::new();
        prereqs.insert("B".into(), vec!["A".into()]);
        assert_eq!(dependency_ok("C", "B", &prereqs), Ok(()));
        assert_eq!(
            dependency_ok("A", "B", &prereqs),
            Err(GraphError::ReachesTask)
        );
        assert_eq!(
            dependency_ok("A", "A", &prereqs),
            Err(GraphError::SelfDependency)
        );
    }
}
