//! Copying an agent reply with its formatting: HTML (tables, headings, lists, code)
//! for apps that paste rich text — Google Docs, Slack, Mail, Notes — plus the
//! Markdown as plain text for everything else. GPUI's clipboard is plain text only,
//! so on macOS this writes the pasteboard itself.

use gpui_kit::*;

/// The reply as pasteable HTML: GitHub-flavoured Markdown (tables included), with
/// light inline borders on tables so they survive the paste as tables.
pub fn markdown_html(md: &str) -> String {
    let body = markdown::to_html_with_options(md, &markdown::Options::gfm()).unwrap_or_else(|_| markdown::to_html(md));
    let cell = r#"style="border:1px solid #d0d7de;padding:4px 8px;text-align:left""#;
    let body = body
        .replace("<table>", r#"<table style="border-collapse:collapse">"#)
        .replace("<th>", &format!("<th {cell}>"))
        .replace("<td>", &format!("<td {cell}>"))
        .replace("<th align=", &format!("<th {cell} align="))
        .replace("<td align=", &format!("<td {cell} align="));
    format!("<meta charset=\"utf-8\">{body}")
}

/// Put `md` on the clipboard as rich text (HTML) with the Markdown as its plain text.
pub fn copy_rich(md: &str, cx: &mut App) {
    #[cfg(target_os = "macos")]
    if mac::write(&markdown_html(md), md) {
        return;
    }
    cx.write_to_clipboard(ClipboardItem::new_string(md.to_string()));
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    /// HTML + plain text on the general pasteboard; false if it couldn't.
    pub fn write(html: &str, plain: &str) -> bool {
        unsafe {
            let pb: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
            if pb.is_null() {
                return false;
            }
            let _: isize = msg_send![pb, clearContents];
            let html_ok: Bool = msg_send![pb, setString: &*NSString::from_str(html), forType: &*NSString::from_str("public.html")];
            let text_ok: Bool = msg_send![pb, setString: &*NSString::from_str(plain), forType: &*NSString::from_str("public.utf8-plain-text")];
            html_ok.as_bool() && text_ok.as_bool()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::markdown_html;

    #[test]
    fn tables_and_formatting_become_html() {
        let html = markdown_html("## Plan\n\n| MR | State |\n|---|---|\n| !3212 | **Merged** |\n\n- one\n- `two`");
        assert!(html.contains("<h2>Plan</h2>"));
        assert!(html.contains(r#"<table style="border-collapse:collapse">"#));
        assert!(html.contains("!3212</td>") && html.contains("<strong>Merged</strong>"));
        assert!(html.contains("<li><code>two</code></li>"));
    }
}
