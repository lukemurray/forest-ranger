//! A worktree's tab layout: a tree whose leaves are tab groups (ordered tab keys,
//! one active) and whose inner nodes are splits (row = side by side, col =
//! stacked). Pure data, kept reconciled against the open tabs; the shell renders it.

use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq)]
pub struct Group {
    pub id: String,
    pub tabs: Vec<String>,
    pub active: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Dir {
    Row,
    Col,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    Group(Group),
    /// `sizes`: fractions summing to 1, one per child.
    Split { id: String, dir: Dir, children: Vec<Node>, sizes: Vec<f32> },
}

/// Where a dropped tab lands: into a group, or split off one of its edges.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Drop {
    Center,
    Left,
    Right,
    Top,
    Bottom,
}

fn nid(p: &str) -> String {
    format!("{p}_{}", &uuid::Uuid::new_v4().simple().to_string()[..10])
}

pub fn group(tabs: Vec<String>) -> Node {
    let active = tabs.last().cloned();
    Node::Group(Group { id: nid("g"), tabs, active })
}

impl Default for Node {
    fn default() -> Self {
        group(vec![])
    }
}

fn equal(n: usize) -> Vec<f32> {
    vec![1. / n as f32; n]
}

impl Node {
    pub fn all_tabs(&self) -> Vec<String> {
        match self {
            Node::Group(g) => g.tabs.clone(),
            Node::Split { children, .. } => children.iter().flat_map(Node::all_tabs).collect(),
        }
    }

    pub fn groups(&self) -> Vec<&Group> {
        match self {
            Node::Group(g) => vec![g],
            Node::Split { children, .. } => children.iter().flat_map(Node::groups).collect(),
        }
    }

    pub fn group_of(&self, tab: &str) -> Option<&Group> {
        self.groups().into_iter().find(|g| g.tabs.iter().any(|t| t == tab))
    }

    fn first_group(&self) -> &Group {
        match self {
            Node::Group(g) => g,
            Node::Split { children, .. } => children[0].first_group(),
        }
    }

    /// Replace the group `id` with `f(group)` (which may return a split).
    fn map_group(self, id: &str, f: &mut impl FnMut(Group) -> Node) -> Node {
        match self {
            Node::Group(g) if g.id == id => f(g),
            Node::Group(g) => Node::Group(g),
            Node::Split { id: sid, dir, children, sizes } => {
                Node::Split { id: sid, dir, children: children.into_iter().map(|c| c.map_group(id, f)).collect(), sizes }
            }
        }
    }

    fn map_groups(self, f: &mut impl FnMut(Group) -> Group) -> Node {
        match self {
            Node::Group(g) => Node::Group(f(g)),
            Node::Split { id, dir, children, sizes } => {
                Node::Split { id, dir, children: children.into_iter().map(|c| c.map_groups(f)).collect(), sizes }
            }
        }
    }

    /// Remove `tab` wherever it is (may leave an empty group; simplify after).
    fn strip(self, tab: &str) -> Node {
        self.map_groups(&mut |mut g| {
            if g.tabs.iter().any(|t| t == tab) {
                g.tabs.retain(|t| t != tab);
                if g.active.as_deref() == Some(tab) {
                    g.active = g.tabs.last().cloned();
                }
            }
            g
        })
    }

    /// Drop empty groups, flatten same-direction nesting, unwrap single-child
    /// splits. Sizes survive when the child count does, else are equalised.
    fn simplify(self) -> Option<Node> {
        match self {
            Node::Group(g) => (!g.tabs.is_empty()).then_some(Node::Group(g)),
            Node::Split { id, dir, children, sizes } => {
                let before = children.len();
                let mut kept: Vec<(Node, f32)> = vec![];
                for (c, s) in children.into_iter().zip(sizes.iter().copied().chain(std::iter::repeat(0.))) {
                    match c.simplify() {
                        Some(Node::Split { dir: d, children: cs, sizes: ss, .. }) if d == dir => {
                            kept.extend(cs.into_iter().zip(ss.into_iter().map(|x| x * s)))
                        }
                        Some(n) => kept.push((n, s)),
                        None => {}
                    }
                }
                match kept.len() {
                    0 => None,
                    1 => kept.pop().map(|(n, _)| n),
                    n => {
                        let sum: f32 = kept.iter().map(|k| k.1).sum();
                        let sizes = if n == before && sum > 0. { kept.iter().map(|k| k.1 / sum).collect() } else { equal(n) };
                        Some(Node::Split { id, dir, children: kept.into_iter().map(|k| k.0).collect(), sizes })
                    }
                }
            }
        }
    }

    /// Add tabs not already placed to the group holding `focus` (else the first).
    pub fn insert(self, tabs: &[String], focus: Option<&str>) -> Node {
        let have = self.all_tabs();
        let add: Vec<String> = tabs.iter().filter(|t| !have.contains(t)).cloned().collect();
        let Some(last) = add.last().cloned() else { return self };
        let home = focus.and_then(|f| self.group_of(f)).unwrap_or_else(|| self.first_group()).id.clone();
        self.map_group(&home, &mut |mut g| {
            g.tabs.extend(add.iter().cloned());
            g.active = Some(last.clone());
            Node::Group(g)
        })
    }

    /// Move `tab` into group `target` at `index` (default: the end) and make it active.
    pub fn move_tab(self, tab: &str, target: &str, index: Option<usize>) -> Node {
        // Reordering within a group: the index counts the tab's old slot too.
        let index = match (index, self.group_of(tab)) {
            (Some(i), Some(g)) if g.id == target => g.tabs.iter().position(|t| t == tab).map(|old| if old < i { i - 1 } else { i }),
            (i, _) => i,
        };
        let placed = self.strip(tab).map_group(target, &mut |mut g| {
            let at = index.unwrap_or(g.tabs.len()).min(g.tabs.len());
            g.tabs.insert(at, tab.to_string());
            g.active = Some(tab.to_string());
            Node::Group(g)
        });
        placed.simplify().unwrap_or_else(|| group(vec![tab.to_string()]))
    }

    /// Split group `target`, peeling `tab` into a new group on the `side` edge.
    pub fn split_off(self, tab: &str, target: &str, side: Drop) -> Node {
        let (dir, before) = match side {
            Drop::Left => (Dir::Row, true),
            Drop::Right => (Dir::Row, false),
            Drop::Top => (Dir::Col, true),
            Drop::Bottom => (Dir::Col, false),
            Drop::Center => return self.move_tab(tab, target, None),
        };
        // Splitting a group off itself with nothing left behind is a no-op.
        if self.group_of(tab).is_some_and(|g| g.id == target && g.tabs.len() == 1) {
            return self;
        }
        let split = self.strip(tab).map_group(target, &mut |g| {
            let fresh = group(vec![tab.to_string()]);
            let children = if before { vec![fresh, Node::Group(g)] } else { vec![Node::Group(g), fresh] };
            Node::Split { id: nid("s"), dir, children, sizes: vec![0.5, 0.5] }
        });
        split.simplify().unwrap_or_else(|| group(vec![tab.to_string()]))
    }

    /// Make `tab` the active tab of its group.
    pub fn set_active(self, tab: &str) -> Node {
        self.map_groups(&mut |mut g| {
            if g.tabs.iter().any(|t| t == tab) {
                g.active = Some(tab.to_string());
            }
            g
        })
    }

    /// A tab changed key in place (a reused preview tab swapped its file).
    pub fn rename(self, old: &str, new: &str) -> Node {
        if old == new {
            return self;
        }
        self.strip(new).map_groups(&mut |mut g| {
            for t in g.tabs.iter_mut().filter(|t| *t == old) {
                *t = new.to_string();
            }
            if g.active.as_deref() == Some(old) {
                g.active = Some(new.to_string());
            }
            g
        })
    }

    pub fn sizes(&self, split: &str) -> Option<&[f32]> {
        match self {
            Node::Split { id, sizes, .. } if id == split => Some(sizes),
            Node::Split { children, .. } => children.iter().find_map(|c| c.sizes(split)),
            Node::Group(_) => None,
        }
    }

    pub fn set_sizes(self, split: &str, new: Vec<f32>) -> Node {
        match self {
            Node::Split { id, dir, children, .. } if id == split => Node::Split { id, dir, children, sizes: new },
            Node::Split { id, dir, children, sizes } => {
                let children = children.into_iter().map(|c| c.set_sizes(split, new.clone())).collect();
                Node::Split { id, dir, children, sizes }
            }
            g => g,
        }
    }

    pub fn remove(self, tab: &str) -> Node {
        self.strip(tab).simplify().unwrap_or_default()
    }

    /// Make the tree hold exactly `tabs`: drop the gone, add the missing to the
    /// group of `focus` (else the first).
    pub fn reconcile(self, tabs: &[String], focus: Option<&str>) -> Node {
        let mut n = self;
        for t in n.all_tabs() {
            if !tabs.contains(&t) {
                n = n.strip(&t);
            }
        }
        // Duplicates (a hand-edited file): keep the first.
        let mut seen = vec![];
        n = n.map_groups(&mut |mut g| {
            g.tabs.retain(|t| if seen.contains(t) { false } else { seen.push(t.clone()); true });
            if g.active.as_ref().is_none_or(|a| !g.tabs.contains(a)) {
                g.active = g.tabs.last().cloned();
            }
            g
        });
        n.simplify().unwrap_or_default().insert(tabs, focus)
    }

    pub fn to_json(&self) -> Value {
        match self {
            Node::Group(g) => json!({ "kind": "group", "id": g.id, "tabs": g.tabs, "active": g.active }),
            Node::Split { id, dir, children, sizes } => json!({
                "kind": "split",
                "id": id,
                "dir": if *dir == Dir::Row { "row" } else { "col" },
                "children": children.iter().map(Node::to_json).collect::<Vec<_>>(),
                "sizes": sizes,
            }),
        }
    }

    pub fn from_json(v: &Value) -> Option<Node> {
        let id = v["id"].as_str().map(str::to_string).unwrap_or_else(|| nid("n"));
        match v["kind"].as_str()? {
            "group" => {
                let tabs = v["tabs"].as_array()?.iter().filter_map(|t| t.as_str().map(str::to_string)).collect();
                Some(Node::Group(Group { id, tabs, active: v["active"].as_str().map(str::to_string) }))
            }
            "split" => {
                let dir = if v["dir"].as_str() == Some("col") { Dir::Col } else { Dir::Row };
                let children: Vec<Node> = v["children"].as_array()?.iter().filter_map(Node::from_json).collect();
                let mut sizes: Vec<f32> = v["sizes"].as_array().map(|a| a.iter().filter_map(|s| s.as_f64()).map(|s| s as f32).collect()).unwrap_or_default();
                if sizes.len() != children.len() || sizes.iter().any(|s| !s.is_finite() || *s <= 0.) {
                    sizes = equal(children.len().max(1));
                }
                Some(Node::Split { id, dir, children, sizes })
            }
            _ => None,
        }
    }
}

/// A pointer at (x, y) within a w × h pane body: the centre third moves the tab
/// into the group, the outer bands split off the nearest edge.
pub fn drop_at(x: f32, y: f32, w: f32, h: f32) -> Drop {
    let (fx, fy) = (x / w.max(1.), y / h.max(1.));
    if fx > 0.33 && fx < 0.67 && fy > 0.33 && fy < 0.67 {
        return Drop::Center;
    }
    [(Drop::Left, fx), (Drop::Right, 1. - fx), (Drop::Top, fy), (Drop::Bottom, 1. - fy)]
        .into_iter()
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|d| d.0)
        .unwrap_or(Drop::Center)
}

/// Sizes after dragging the divider after child `i` to fraction `at` of the split.
pub fn resize(sizes: &[f32], i: usize, at: f32) -> Option<Vec<f32>> {
    let pair = sizes.get(i)? + sizes.get(i + 1)?;
    let before: f32 = sizes[..i].iter().sum();
    let a = (at - before).clamp(0.1, (pair - 0.1).max(0.1));
    let mut next = sizes.to_vec();
    next[i] = a;
    next[i + 1] = pair - a;
    Some(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn gid(n: &Node, tab: &str) -> String {
        n.group_of(tab).unwrap().id.clone()
    }

    #[test]
    fn split_move_collapse() {
        let n = group(keys(&["a", "b", "c"]));
        let g = gid(&n, "a");
        let n = n.split_off("c", &g, Drop::Right);
        assert!(matches!(&n, Node::Split { dir: Dir::Row, children, .. } if children.len() == 2));
        assert_eq!(n.groups()[0].tabs, keys(&["a", "b"]));
        assert_eq!(n.groups()[1].tabs, keys(&["c"]));
        // New tabs go to the focused group.
        let n = n.insert(&keys(&["d"]), Some("c"));
        assert_eq!(n.groups()[1].tabs, keys(&["c", "d"]));
        assert_eq!(n.groups()[1].active.as_deref(), Some("d"));
        // Moving the right group's tabs back collapses the split.
        let left = gid(&n, "a");
        let n = n.move_tab("c", &left, Some(0)).move_tab("d", &left, None);
        assert!(matches!(&n, Node::Group(g) if g.tabs == keys(&["c", "a", "b", "d"])));
        // Splitting a lone tab off its own group changes nothing.
        let one = group(keys(&["x"]));
        assert_eq!(one.clone().split_off("x", &gid(&one, "x"), Drop::Left), one);
    }

    #[test]
    fn reorder_within_group() {
        let n = group(keys(&["a", "b", "c"]));
        let g = gid(&n, "a");
        // Dropped on "c" (index 2): lands before it.
        let n = n.move_tab("a", &g, Some(2));
        assert_eq!(n.all_tabs(), keys(&["b", "a", "c"]));
    }

    #[test]
    fn nested_flatten_remove_reconcile_json() {
        let n = group(keys(&["a", "b", "c"]));
        let g = gid(&n, "a");
        let n = n.split_off("b", &g, Drop::Right);
        let gb = gid(&n, "b");
        let n = n.split_off("c", &gb, Drop::Right);
        // Same-direction nesting flattens into one three-way row.
        assert!(matches!(&n, Node::Split { children, .. } if children.len() == 3));
        let n = n.remove("b");
        assert!(matches!(&n, Node::Split { children, sizes, .. } if children.len() == 2 && sizes == &vec![0.5, 0.5]));
        let back = Node::from_json(&n.to_json()).unwrap();
        assert_eq!(back, n);
        let n = n.reconcile(&keys(&["c", "z"]), None);
        assert!(matches!(&n, Node::Group(g) if g.tabs == keys(&["c", "z"])));
        assert_eq!(n.rename("z", "y").all_tabs(), keys(&["c", "y"]));
    }

    #[test]
    fn drop_zones_and_resize() {
        assert_eq!(drop_at(50., 50., 100., 100.), Drop::Center);
        assert_eq!(drop_at(5., 50., 100., 100.), Drop::Left);
        assert_eq!(drop_at(50., 95., 100., 100.), Drop::Bottom);
        assert_eq!(resize(&[0.5, 0.5], 0, 0.7), Some(vec![0.7, 0.3]));
        assert!((resize(&[0.5, 0.5], 0, 0.99).unwrap()[1] - 0.1).abs() < 1e-4);
        assert_eq!(resize(&[0.5], 0, 0.5), None);
    }
}
