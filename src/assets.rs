//! Our own icons (the Electron app's marks, from icons.tsx), served ahead of the
//! kit's bundled Lucide set.

use std::borrow::Cow;

use gpui_kit::*;

/// Stroke-only 24px icons, like the Electron app's `svg()` helper.
macro_rules! svg {
    ($($inner:literal),*) => {
        concat!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">"#,
            $($inner,)*
            "</svg>"
        )
    };
}

const ICONS: &[(&str, &str)] = &[
    ("fr/tree.svg", svg!(r#"<path d="M12 2 4 14h16L12 2Z"/><path d="M12 14v8"/><path d="M8 9h8"/>"#)),
    (
        "fr/sprout.svg",
        svg!(r#"<path d="M12 21v-8"/><path d="M12 13C8 13 6 10 6 6c4 0 6 3 6 7Z"/><path d="M12 13c0-3 2-6 6-6 0 4-2 6-6 6Z"/>"#),
    ),
    ("fr/chevron.svg", svg!(r#"<path d="m9 18 6-6-6-6"/>"#)),
    ("fr/chevron-down.svg", svg!(r#"<path d="m6 9 6 6 6-6"/>"#)),
    (
        "fr/home.svg",
        svg!(
            r#"<path d="M15 21v-8a1 1 0 0 0-1-1h-2a1 1 0 0 0-1 1v8"/>"#,
            r#"<path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>"#
        ),
    ),
    ("fr/plus.svg", svg!(r#"<path d="M12 5v14"/><path d="M5 12h14"/>"#)),
    (
        "fr/panel-right.svg",
        svg!(r#"<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>"#),
    ),
    (
        "fr/sparkle.svg",
        svg!(
            r#"<path d="M12 3l1.6 4.6L18 9.2l-4.4 1.6L12 15l-1.6-4.2L6 9.2l4.4-1.6L12 3Z"/>"#,
            r#"<path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14Z"/>"#
        ),
    ),
    (
        "fr/git-branch.svg",
        svg!(
            r#"<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/>"#,
            r#"<path d="M6 9v6"/><path d="M18 9a9 9 0 0 1-9 9"/>"#
        ),
    ),
    ("fr/folder.svg", svg!(r#"<path d="M4 5h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"/>"#)),
    ("fr/file.svg", svg!(r#"<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>"#)),
    ("fr/arrow-left.svg", svg!(r#"<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>"#)),
    ("fr/arrow-right.svg", svg!(r#"<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>"#)),
    ("fr/chevron-up-down.svg", svg!(r#"<path d="m8 9 4-4 4 4"/><path d="m16 15-4 4-4-4"/>"#)),
    ("fr/refresh.svg", svg!(r#"<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v5h-5"/>"#)),
    (
        "fr/terminal.svg",
        svg!(r#"<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/>"#),
    ),
    ("fr/download.svg", svg!(r#"<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/>"#)),
    ("fr/play.svg", svg!(r#"<path d="M7 4.5v15l12-7.5-12-7.5Z"/>"#)),
    (
        "fr/pencil.svg",
        svg!(r#"<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"/>"#),
    ),
    (
        "fr/trash.svg",
        svg!(
            r#"<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/>"#,
            r#"<path d="M5 7l1 13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/>"#
        ),
    ),
    (
        "fr/reveal.svg",
        svg!(r#"<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>"#),
    ),
    (
        "fr/ellipsis.svg",
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="black"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>"#,
    ),
];

pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> gpui_kit::Result<Option<Cow<'static, [u8]>>> {
        match ICONS.iter().find(|(p, _)| *p == path) {
            Some((_, svg)) => Ok(Some(Cow::Borrowed(svg.as_bytes()))),
            None => gpui_kit::assets::Assets.load(path),
        }
    }

    fn list(&self, path: &str) -> gpui_kit::Result<Vec<SharedString>> {
        gpui_kit::assets::Assets.list(path)
    }
}
