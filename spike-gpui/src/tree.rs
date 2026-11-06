//! The Files view's tree (the Electron app's buildTree / collapseDir / flattenTree):
//! folders first with file counts, single-child folder chains collapsed into one
//! row (".agents/skills"), gitignored entries flagged so they can be dimmed.

use std::collections::{BTreeMap, HashSet};

#[derive(Default)]
pub struct Dir {
    dirs: BTreeMap<String, Dir>,
    files: Vec<(String, bool)>,
    count: usize,
    ignored: bool,
    /// An ignored folder whose contents haven't been listed yet.
    unlisted: bool,
}

pub struct Row {
    pub path: String,
    pub name: String,
    pub depth: usize,
    pub is_dir: bool,
    pub count: usize,
    pub expanded: bool,
    pub ignored: bool,
    pub unlisted: bool,
}

impl Dir {
    /// Build from tracked files, ignored files, and unlisted ignored folders,
    /// keeping only paths containing `filter` (lowercased; empty = all).
    pub fn build(files: &[String], ignored: &[String], unlisted: &HashSet<String>, filter: &str) -> Dir {
        let mut root = Dir::default();
        let keep = |p: &str| filter.is_empty() || p.to_lowercase().contains(filter);
        for (path, ign) in files.iter().map(|p| (p, false)).chain(ignored.iter().map(|p| (p, true))) {
            if keep(path) {
                root.insert(path, ign);
            }
        }
        if filter.is_empty() {
            for d in unlisted {
                let node = root.dir_mut(d);
                node.ignored = true;
                node.unlisted = true;
            }
        }
        root.finish();
        root
    }

    fn dir_mut(&mut self, path: &str) -> &mut Dir {
        path.split('/').filter(|s| !s.is_empty()).fold(self, |d, part| d.dirs.entry(part.to_string()).or_default())
    }

    fn insert(&mut self, path: &str, ignored: bool) {
        let (dir, name) = path.rsplit_once('/').unwrap_or(("", path));
        self.dir_mut(dir).files.push((name.to_string(), ignored));
    }

    /// Counts, ignored-ness (a folder is ignored if everything in it is), sorting.
    fn finish(&mut self) {
        let mut all_ignored = true;
        let mut count = self.files.len();
        for d in self.dirs.values_mut() {
            d.finish();
            count += d.count;
            all_ignored &= d.ignored;
        }
        all_ignored &= self.files.iter().all(|f| f.1);
        self.count = count;
        self.ignored = self.ignored || (count > 0 && all_ignored);
        self.files.sort_by_key(|f| f.0.to_lowercase());
    }

    /// Visible rows: open folders' children follow them; `all_open` when filtering.
    pub fn flatten(&self, prefix: &str, depth: usize, expanded: &HashSet<String>, all_open: bool, out: &mut Vec<Row>) {
        let mut dirs: Vec<(&String, &Dir)> = self.dirs.iter().collect();
        dirs.sort_by_key(|(n, _)| n.to_lowercase());
        for (name, mut dir) in dirs {
            // Collapse a chain of folders that each hold just one folder.
            let mut label = name.clone();
            while dir.files.is_empty() && dir.dirs.len() == 1 && !dir.unlisted {
                let (n, d) = dir.dirs.iter().next().unwrap();
                label = format!("{label}/{n}");
                dir = d;
            }
            let path = if prefix.is_empty() { label.clone() } else { format!("{prefix}/{label}") };
            let open = all_open || expanded.contains(&path);
            out.push(Row {
                path: path.clone(),
                name: label,
                depth,
                is_dir: true,
                count: dir.count,
                expanded: open,
                ignored: dir.ignored,
                unlisted: dir.unlisted,
            });
            if open {
                dir.flatten(&path, depth + 1, expanded, all_open, out);
            }
        }
        for (name, ignored) in &self.files {
            out.push(Row {
                path: if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") },
                name: name.clone(),
                depth,
                is_dir: false,
                count: 0,
                expanded: false,
                ignored: *ignored,
                unlisted: false,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapses_chains_and_counts() {
        let files: Vec<String> =
            [".agents/skills/a/SKILL.md", ".agents/skills/b/SKILL.md", "src/main.rs", "README.md"].map(String::from).to_vec();
        let ignored = vec!["src/.env".to_string()];
        let tree = Dir::build(&files, &ignored, &HashSet::new(), "");
        let mut rows = vec![];
        tree.flatten("", 0, &HashSet::new(), false, &mut rows);
        let names: Vec<_> = rows.iter().map(|r| (r.name.as_str(), r.count)).collect();
        assert_eq!(names, [(".agents/skills", 2), ("src", 2), ("README.md", 0)]);

        let open: HashSet<String> = ["src".to_string()].into();
        let mut rows = vec![];
        tree.flatten("", 0, &open, false, &mut rows);
        let env = rows.iter().find(|r| r.name == ".env").unwrap();
        assert!(env.ignored && env.depth == 1 && env.path == "src/.env");

        let filtered = Dir::build(&files, &ignored, &HashSet::new(), "skill");
        let mut rows = vec![];
        filtered.flatten("", 0, &HashSet::new(), true, &mut rows);
        assert_eq!(rows.iter().filter(|r| !r.is_dir).count(), 2);
    }
}
