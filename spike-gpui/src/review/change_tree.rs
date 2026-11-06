//! Changed files as a folder tree (ReviewPanel.tsx buildTree / collapseDir /
//! aggregate / flattenTree): folders first, single-child folder chains collapsed,
//! folder rows carry the file count and summed +/−. Plus the keyboard model the
//! panel's trees share.

use std::collections::{BTreeMap, HashSet};

use crate::git::ChangedFile;

pub struct Row {
    pub path: String,
    pub name: String,
    pub depth: usize,
    pub is_dir: bool,
    pub count: usize,
    pub ins: u32,
    pub del: u32,
    pub expanded: bool,
    /// Index into the files the tree was built from.
    pub file: Option<usize>,
}

#[derive(Default)]
struct Node {
    dirs: BTreeMap<String, Node>,
    files: Vec<usize>,
}

/// Visible rows, folders open unless in `collapsed` (or all open when `force_open`).
pub fn rows(files: &[ChangedFile], collapsed: &HashSet<String>, force_open: bool) -> Vec<Row> {
    let mut root = Node::default();
    for (i, f) in files.iter().enumerate() {
        let dir = f.path.rsplit_once('/').map_or("", |d| d.0);
        dir.split('/').filter(|s| !s.is_empty()).fold(&mut root, |n, part| n.dirs.entry(part.to_string()).or_default()).files.push(i);
    }
    let mut out = vec![];
    root.flatten(files, "", 0, &|p| force_open || !collapsed.contains(p), &mut out);
    out
}

impl Node {
    fn totals(&self, files: &[ChangedFile]) -> (usize, u32, u32) {
        let own = self.files.iter().map(|&i| &files[i]);
        let (mut n, mut ins, mut del) =
            (self.files.len(), own.clone().map(|f| f.insertions.unwrap_or(0)).sum(), own.map(|f| f.deletions.unwrap_or(0)).sum());
        for d in self.dirs.values() {
            let (a, b, c) = d.totals(files);
            (n, ins, del) = (n + a, ins + b, del + c);
        }
        (n, ins, del)
    }

    fn flatten(&self, files: &[ChangedFile], prefix: &str, depth: usize, open: &dyn Fn(&str) -> bool, out: &mut Vec<Row>) {
        let mut dirs: Vec<_> = self.dirs.iter().collect();
        dirs.sort_by_key(|(n, _)| n.to_lowercase());
        for (name, mut dir) in dirs {
            let mut label = name.clone();
            while dir.files.is_empty() && dir.dirs.len() == 1 {
                let (n, d) = dir.dirs.iter().next().unwrap();
                label = format!("{label}/{n}");
                dir = d;
            }
            let path = if prefix.is_empty() { label.clone() } else { format!("{prefix}/{label}") };
            let (count, ins, del) = dir.totals(files);
            let expanded = open(&path);
            out.push(Row { path: path.clone(), name: label, depth, is_dir: true, count, ins, del, expanded, file: None });
            if expanded {
                dir.flatten(files, &path, depth + 1, open, out);
            }
        }
        let mut own = self.files.clone();
        own.sort_by_key(|&i| files[i].path.rsplit('/').next().unwrap_or_default().to_lowercase());
        for i in own {
            let f = &files[i];
            out.push(Row {
                path: f.path.clone(),
                name: f.path.rsplit('/').next().unwrap_or_default().to_string(),
                depth,
                is_dir: false,
                count: 0,
                ins: f.insertions.unwrap_or(0),
                del: f.deletions.unwrap_or(0),
                expanded: false,
                file: Some(i),
            });
        }
    }
}

/// Files at or under `dir`.
pub fn under<'a>(files: &'a [ChangedFile], dir: &'a str) -> impl Iterator<Item = &'a ChangedFile> + 'a {
    files.iter().filter(move |f| f.path == dir || f.path.strip_prefix(dir).is_some_and(|r| r.starts_with('/')))
}

pub enum Nav {
    Focus(usize),
    /// Open (true) or close a folder row.
    Expand(usize, bool),
    Activate(usize),
    Stage(usize),
}

/// What a key does on a tree (FileTree's onKeyDown). `rows` are (depth, is_dir, expanded).
pub fn nav(key: &str, focus: usize, rows: &[(usize, bool, bool)]) -> Option<Nav> {
    let last = rows.len().checked_sub(1)?;
    let i = focus.min(last);
    let (depth, is_dir, expanded) = rows[i];
    Some(match key {
        "down" => Nav::Focus((i + 1).min(last)),
        "up" => Nav::Focus(i.saturating_sub(1)),
        "home" => Nav::Focus(0),
        "end" => Nav::Focus(last),
        "right" if is_dir && !expanded => Nav::Expand(i, true),
        "right" if is_dir => Nav::Focus((i + 1).min(last)),
        "left" if is_dir && expanded => Nav::Expand(i, false),
        "left" => Nav::Focus((0..i).rev().find(|&j| rows[j].0 < depth)?),
        "s" => Nav::Stage(i),
        "enter" | "space" => Nav::Activate(i),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::ChangeKind;

    fn f(path: &str, ins: u32, del: u32) -> ChangedFile {
        ChangedFile { path: path.into(), kind: ChangeKind::Modified, insertions: Some(ins), deletions: Some(del), staged: false }
    }

    #[test]
    fn builds_collapses_and_navigates() {
        let files = [f("src/main/a.rs", 1, 2), f("src/main/b.rs", 3, 0), f("README.md", 5, 5), f("docs/x.md", 1, 1)];
        let rows = rows(&files, &HashSet::new(), false);
        let names: Vec<_> = rows.iter().map(|r| (r.name.as_str(), r.depth, r.count, r.ins, r.del)).collect();
        assert_eq!(
            names,
            [("docs", 0, 1, 1, 1), ("x.md", 1, 0, 1, 1), ("src/main", 0, 2, 4, 2), ("a.rs", 1, 0, 1, 2), ("b.rs", 1, 0, 3, 0), ("README.md", 0, 0, 5, 5)]
        );
        assert_eq!(rows[3].file, Some(0));
        assert_eq!(under(&files, "src/main").count(), 2);
        assert_eq!(under(&files, "src/ma").count(), 0);

        let closed: HashSet<String> = ["src/main".to_string()].into();
        assert_eq!(super::rows(&files, &closed, false).len(), 4);
        assert_eq!(super::rows(&files, &closed, true).len(), 6);

        let nav_rows: Vec<_> = rows.iter().map(|r| (r.depth, r.is_dir, r.expanded)).collect();
        assert!(matches!(nav("left", 4, &nav_rows), Some(Nav::Focus(2))));
        assert!(matches!(nav("left", 2, &nav_rows), Some(Nav::Expand(2, false))));
        assert!(matches!(nav("right", 2, &nav_rows), Some(Nav::Focus(3))));
        assert!(matches!(nav("end", 0, &nav_rows), Some(Nav::Focus(5))));
        assert!(matches!(nav("up", 0, &nav_rows), Some(Nav::Focus(0))));
        assert!(nav("left", 5, &nav_rows).is_none());
        assert!(nav("down", 0, &[]).is_none());
    }
}
