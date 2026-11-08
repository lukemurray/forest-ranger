//! Shell UI state that survives a restart: per worktree its open tabs, active tab,
//! focus order, review-panel state and recent files; globally the sidebar and
//! panel widths. The Electron app keeps these in localStorage, which we can't
//! read, so they live in `~/.forest-ranger/gpui-state.json`. Read and written only
//! through this module (a Global, saved shortly after each change).

use std::collections::HashMap;
use std::time::Duration;

use gpui_kit::*;
use serde_json::{Value, json};

use crate::data::data_dir;
use crate::panes::Node;

const RECENT_CAP: usize = 50;
pub const SIDEBAR_WIDTH: (f32, f32, f32) = (200., 264., 520.);
pub const PANEL_WIDTH: (f32, f32, f32) = (320., 480., 900.);

#[derive(Clone, Debug, PartialEq)]
pub struct Panel {
    pub open: bool,
    /// "review" | "files" | "search"
    pub view: String,
    /// The Review view's Files / Commits toggle.
    pub commits: bool,
}

impl Default for Panel {
    fn default() -> Self {
        Self { open: true, view: "review".into(), commits: false }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Worktree {
    /// Tab keys in order (`chat:<id>`, `file:<rel>`, `diff:<base>:<path>`).
    pub tabs: Vec<String>,
    pub active: Option<String>,
    /// Tab keys, most recently focused first.
    pub mru: Vec<String>,
    pub panel: Option<Panel>,
    /// Recently opened files, newest first.
    pub recent: Vec<String>,
    /// Renamed file / diff tabs: tab key → title.
    pub titles: HashMap<String, String>,
    /// How the tabs are split into groups (None: one group, in `tabs` order).
    pub layout: Option<Node>,
    /// The preview (italic) tab's key.
    pub preview: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SessionState {
    pub worktrees: HashMap<String, Worktree>,
    pub sidebar_width: f32,
    pub panel_width: f32,
    /// What a worktree not visited yet starts with: the last panel state used.
    pub last_panel: Panel,
    /// The sidebar's expanded projects, and where you were (a worktree id or
    /// `project:<id>`), restored on the next launch.
    pub expanded: Vec<String>,
    pub location: Option<String>,
    /// Diff tabs' last-used toggles; new diff tabs open the same way.
    pub diff_unified: bool,
    pub diff_full: bool,
    save_pending: bool,
}

impl Global for SessionState {}

fn file() -> std::path::PathBuf {
    data_dir().join("gpui-state.json")
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn panel_of(v: &Value) -> Option<Panel> {
    let d = Panel::default();
    v.is_object().then(|| Panel {
        open: v["open"].as_bool().unwrap_or(d.open),
        view: v["view"].as_str().filter(|s| matches!(*s, "review" | "files" | "search")).unwrap_or(&d.view).to_string(),
        commits: v["commits"].as_bool().unwrap_or(d.commits),
    })
}

fn panel_json(p: &Panel) -> Value {
    json!({ "open": p.open, "view": p.view, "commits": p.commits })
}

fn clamp(v: Option<f64>, (lo, def, hi): (f32, f32, f32)) -> f32 {
    v.map(|v| (v as f32).clamp(lo, hi)).unwrap_or(def)
}

impl SessionState {
    pub fn from_json(v: &Value) -> Self {
        let worktrees = v["worktrees"]
            .as_object()
            .map(|m| {
                m.iter()
                    .map(|(id, w)| {
                        let rec = Worktree {
                            tabs: strings(&w["tabs"]),
                            active: w["active"].as_str().map(str::to_string),
                            mru: strings(&w["mru"]),
                            panel: panel_of(&w["panel"]),
                            recent: strings(&w["recent"]),
                            titles: w["titles"]
                                .as_object()
                                .map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect())
                                .unwrap_or_default(),
                            layout: Node::from_json(&w["layout"]),
                            preview: w["preview"].as_str().map(str::to_string),
                        };
                        (id.clone(), rec)
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self {
            worktrees,
            sidebar_width: clamp(v["sidebarWidth"].as_f64(), SIDEBAR_WIDTH),
            panel_width: clamp(v["panelWidth"].as_f64(), PANEL_WIDTH),
            last_panel: panel_of(&v["lastPanel"]).unwrap_or_default(),
            expanded: strings(&v["expanded"]),
            location: v["location"].as_str().map(str::to_string),
            diff_unified: v["diffUnified"].as_bool().unwrap_or(false),
            diff_full: v["diffFull"].as_bool().unwrap_or(false),
            save_pending: false,
        }
    }

    pub fn to_json(&self) -> Value {
        let wts: serde_json::Map<String, Value> = self
            .worktrees
            .iter()
            .map(|(id, w)| {
                let v = json!({
                    "tabs": w.tabs,
                    "active": w.active,
                    "mru": w.mru,
                    "panel": w.panel.as_ref().map(panel_json),
                    "recent": w.recent,
                    "titles": w.titles,
                    "layout": w.layout.as_ref().map(Node::to_json),
                    "preview": w.preview,
                });
                (id.clone(), v)
            })
            .collect();
        json!({
            "worktrees": wts,
            "sidebarWidth": self.sidebar_width.round(),
            "panelWidth": self.panel_width.round(),
            "lastPanel": panel_json(&self.last_panel),
            "expanded": self.expanded,
            "location": self.location,
            "diffUnified": self.diff_unified,
            "diffFull": self.diff_full,
        })
    }

    pub fn load() -> Self {
        let v: Value = std::fs::read_to_string(file()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Self::from_json(&v)
    }

    /// Atomic: write a sibling temp file, then rename over the real one.
    fn save(&self) {
        if let Err(e) = crate::data::write_atomic(&file(), self.to_json().to_string()) {
            eprintln!("couldn't save session state: {e}");
        }
    }

    pub fn get(cx: &App) -> &Self {
        cx.global::<Self>()
    }

    pub fn worktree<'a>(cx: &'a App, id: &str) -> Option<&'a Worktree> {
        cx.global::<Self>().worktrees.get(id)
    }

    /// Change the state; it's written to disk a moment later (coalescing drags).
    pub fn update(cx: &mut App, f: impl FnOnce(&mut SessionState)) {
        let s = cx.global_mut::<Self>();
        let before = s.clone();
        f(s);
        if *s == before || s.save_pending {
            return;
        }
        s.save_pending = true;
        cx.spawn(async move |cx| {
            cx.background_executor().timer(Duration::from_millis(300)).await;
            let _ = cx.update(|cx| Self::flush(cx));
        })
        .detach();
    }

    /// Write now (also called on quit).
    pub fn flush(cx: &mut App) {
        let s = cx.global_mut::<Self>();
        s.save_pending = false;
        s.save();
    }

    pub fn worktree_mut<'a>(&'a mut self, id: &str) -> &'a mut Worktree {
        self.worktrees.entry(id.to_string()).or_default()
    }

    /// A worktree's panel state; one never seen inherits the last used.
    pub fn panel(&self, id: &str) -> Panel {
        self.worktrees.get(id).and_then(|w| w.panel.clone()).unwrap_or_else(|| self.last_panel.clone())
    }

    pub fn set_panel(&mut self, id: &str, p: Panel) {
        self.worktree_mut(id).panel = Some(p.clone());
        self.last_panel = p;
    }
}

impl Worktree {
    pub fn record_recent(&mut self, rel: &str) {
        self.recent.retain(|r| r != rel);
        self.recent.insert(0, rel.to_string());
        self.recent.truncate(RECENT_CAP);
    }
}

/// The tab to focus after the active one closes: the most recently used one
/// still open, else the last one.
pub fn next_focus<'a>(open: &'a [String], mru: &[String]) -> Option<&'a String> {
    mru.iter().find_map(|m| open.iter().find(|k| *k == m)).or(open.last())
}

// --- window-state.json (the Electron app's window bounds) ---

fn read_window_state() -> Option<(f32, f32, Option<(f32, f32)>)> {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(data_dir().join("window-state.json")).ok()?).ok()?;
    let (w, h) = (v["width"].as_f64()? as f32, v["height"].as_f64()? as f32);
    let pos = v["x"].as_f64().zip(v["y"].as_f64()).map(|(x, y)| (x as f32, y as f32));
    Some((w, h, pos))
}

/// The saved window bounds (Electron's window-state.json), if they still land
/// on a connected display; else centred.
pub(crate) fn initial_bounds(cx: &App) -> Bounds<Pixels> {
    let (w, h, pos) = read_window_state().unwrap_or((1440., 900., None));
    let sz = size(px(w.max(600.)), px(h.max(400.)));
    if let Some((x, y)) = pos {
        let b = Bounds::new(point(px(x), px(y)), sz);
        if cx.displays().iter().any(|d| d.bounds().intersects(&b)) {
            return b;
        }
    }
    Bounds::centered(None, sz, cx)
}

pub(crate) fn write_window_state(b: Bounds<Pixels>) {
    let (o, s) = (b.origin, b.size);
    let v = serde_json::json!({
        "width": f32::from(s.width).round() as i64,
        "height": f32::from(s.height).round() as i64,
        "x": f32::from(o.x).round() as i64,
        "y": f32::from(o.y).round() as i64,
    });
    let _ = crate::data::write_atomic(&data_dir().join("window-state.json"), v.to_string());
}

#[cfg(test)]
mod tests {
    use super::{Panel, RECENT_CAP, SessionState, Worktree, next_focus};
    use serde_json::json;

    #[test]
    fn diff_prefs_round_trip() {
        let mut s = SessionState::from_json(&json!(null));
        assert!(!s.diff_unified && !s.diff_full);
        (s.diff_unified, s.diff_full) = (true, true);
        (s.expanded, s.location) = (vec!["p1".into()], Some("project:p1".into()));
        let back = SessionState::from_json(&s.to_json());
        assert!(back.diff_unified && back.diff_full);
        assert_eq!((back.expanded, back.location.as_deref()), (vec!["p1".to_string()], Some("project:p1")));
    }

    #[test]
    fn round_trip_and_clamp() {
        let mut s = SessionState::from_json(&json!({ "sidebarWidth": 9999, "worktrees": { "w": { "tabs": ["chat:a", "file:x"], "active": "file:x", "titles": { "file:x": "Notes" }, "preview": "file:x" } } }));
        let g = crate::panes::group(vec!["chat:a".into()]);
        let id = g.group_of("chat:a").unwrap().id.clone();
        s.worktree_mut("w").layout = Some(g.insert(&["file:x".into()], None).split_off("file:x", &id, crate::panes::Drop::Bottom));
        assert_eq!(s.sidebar_width, 520.);
        assert_eq!(s.panel_width, 480.);
        assert_eq!(s.panel("w"), Panel::default());
        s.set_panel("w", Panel { open: false, view: "files".into(), commits: true });
        assert_eq!(s.panel("unseen").view, "files");
        let back = SessionState::from_json(&s.to_json());
        assert_eq!(back, s);
        assert_eq!(back.worktrees["w"].tabs, vec!["chat:a", "file:x"]);
        assert_eq!(back.worktrees["w"].titles["file:x"], "Notes");
        assert_eq!(back.worktrees["w"].preview.as_deref(), Some("file:x"));
        assert_eq!(back.worktrees["w"].layout.as_ref().map(|l| l.groups().len()), Some(2));
    }

    #[test]
    fn recent_and_next_focus() {
        let mut w = Worktree::default();
        for i in 0..60 {
            w.record_recent(&format!("f{i}"));
        }
        w.record_recent("f10");
        assert_eq!(w.recent.len(), RECENT_CAP);
        assert_eq!(w.recent[0], "f10");
        w.mru = vec!["a".into(), "b".into()];
        let open = vec!["b".to_string(), "c".to_string()];
        assert_eq!(next_focus(&open, &w.mru).map(String::as_str), Some("b"));
        assert_eq!(next_focus(&open, &[]).map(String::as_str), Some("c"));
        assert_eq!(next_focus(&[], &w.mru), None);
    }
}
