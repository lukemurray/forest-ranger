//! macOS notifications and the Dock badge, for chats that need you while the
//! window is in the background. A clicked notification comes back through
//! `clicks()` as (worktree id, tab key).

use std::sync::OnceLock;

use gpui_kit::component::notification::Notification;
use gpui_kit::component::*;
use gpui_kit::*;

/// In-app toasts. gpui-kit's own pins its icon 18px from the top, which sits low
/// next to our text; here the icon and message share one centred row.
fn toast(kind: u8, msg: impl Into<SharedString>) -> Notification {
    let msg = msg.into();
    Notification::new().content(move |_, _, cx| {
        let t = cx.theme();
        let (icon, color) = match kind {
            0 => (IconName::CircleCheck, t.success),
            1 => (IconName::CircleX, t.danger),
            _ => (IconName::Info, t.info),
        };
        h_flex().items_center().gap_2().child(Icon::new(icon).text_color(color)).child(div().text_sm().child(msg.clone())).into_any_element()
    })
}

pub fn success(msg: impl Into<SharedString>) -> Notification {
    toast(0, msg)
}

pub fn error(msg: impl Into<SharedString>) -> Notification {
    toast(1, msg)
}

pub fn info(msg: impl Into<SharedString>) -> Notification {
    toast(2, msg)
}

type Target = (String, String);

fn channel() -> &'static (async_channel::Sender<Target>, async_channel::Receiver<Target>) {
    static CH: OnceLock<(async_channel::Sender<Target>, async_channel::Receiver<Target>)> = OnceLock::new();
    CH.get_or_init(async_channel::unbounded)
}

/// Notifications the user clicked.
pub fn clicks() -> async_channel::Receiver<Target> {
    channel().1.clone()
}

/// The target travels in the notification's userInfo as "<worktree>\n<tab key>".
fn encode((wt, key): &Target) -> String {
    format!("{wt}\n{key}")
}

fn decode(s: &str) -> Option<Target> {
    let (wt, key) = s.split_once('\n')?;
    Some((wt.to_string(), key.to_string()))
}

#[cfg(target_os = "macos")]
pub use mac::{post, set_badge};

#[cfg(not(target_os = "macos"))]
pub fn post(_title: &str, _body: &str, _target: Target) {}
#[cfg(not(target_os = "macos"))]
pub fn set_badge(_count: usize) {}

#[cfg(target_os = "macos")]
#[allow(deprecated)] // NSUserNotification still works; UNUserNotificationCenter needs a signed, entitled bundle
mod mac {
    use super::{Target, channel, decode, encode};
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, NSObject, Sel};
    use objc2::{ClassType, class, msg_send, sel};
    use objc2_foundation::NSString;
    use std::ffi::{CStr, c_char};
    use std::sync::OnceLock;

    const KEY: &str = "forestRangerTarget";

    unsafe fn rust_str(s: *mut AnyObject) -> Option<String> {
        if s.is_null() {
            return None;
        }
        let p: *const c_char = unsafe { msg_send![s, UTF8String] };
        (!p.is_null()).then(|| unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned())
    }

    extern "C-unwind" fn did_activate(_: *mut AnyObject, _: Sel, _center: *mut AnyObject, note: *mut AnyObject) {
        unsafe {
            let info: *mut AnyObject = msg_send![note, userInfo];
            if info.is_null() {
                return;
            }
            let v: *mut AnyObject = msg_send![info, objectForKey: &*NSString::from_str(KEY)];
            if let Some(t) = rust_str(v).as_deref().and_then(decode) {
                let _ = channel().0.try_send(t);
            }
        }
    }

    /// Show it even if we happen to be frontmost by the time it lands.
    extern "C-unwind" fn should_present(_: *mut AnyObject, _: Sel, _center: *mut AnyObject, _note: *mut AnyObject) -> Bool {
        Bool::YES
    }

    /// The user-notification center with our delegate set, or None (an unbundled
    /// binary may have none — then nothing is posted).
    fn center() -> Option<*mut AnyObject> {
        static DELEGATE: OnceLock<usize> = OnceLock::new();
        unsafe {
            let center: *mut AnyObject = msg_send![class!(NSUserNotificationCenter), defaultUserNotificationCenter];
            if center.is_null() {
                return None;
            }
            DELEGATE.get_or_init(|| {
                let mut b = ClassBuilder::new(c"ForestRangerNotificationDelegate", NSObject::class()).expect("delegate class");
                b.add_method(
                    sel!(userNotificationCenter:didActivateNotification:),
                    did_activate as extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject),
                );
                b.add_method(
                    sel!(userNotificationCenter:shouldPresentNotification:),
                    should_present as extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject) -> Bool,
                );
                let cls: &AnyClass = b.register();
                // Never released: the center holds its delegate weakly.
                let delegate: *mut AnyObject = msg_send![cls, alloc];
                let delegate: *mut AnyObject = msg_send![delegate, init];
                let _: () = msg_send![center, setDelegate: delegate];
                delegate as usize
            });
            Some(center)
        }
    }

    pub fn post(title: &str, body: &str, target: Target) {
        let Some(center) = center() else { return };
        unsafe {
            let n: *mut AnyObject = msg_send![class!(NSUserNotification), alloc];
            let n: *mut AnyObject = msg_send![n, init];
            let _: () = msg_send![n, setTitle: &*NSString::from_str(title)];
            let _: () = msg_send![n, setInformativeText: &*NSString::from_str(body)];
            let info: *mut AnyObject = msg_send![
                class!(NSDictionary),
                dictionaryWithObject: &*NSString::from_str(&encode(&target)),
                forKey: &*NSString::from_str(KEY)
            ];
            let _: () = msg_send![n, setUserInfo: info];
            let _: () = msg_send![center, deliverNotification: n];
        }
    }

    /// The Dock badge: the count, or none at 0.
    pub fn set_badge(count: usize) {
        unsafe {
            let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let tile: *mut AnyObject = msg_send![app, dockTile];
            let label = (count > 0).then(|| NSString::from_str(&count.to_string()));
            let label: *const NSString = label.as_deref().map_or(std::ptr::null(), |l| l as *const NSString);
            let _: () = msg_send![tile, setBadgeLabel: label];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{decode, encode};

    #[test]
    fn target_round_trip() {
        let t = ("wt-1".to_string(), "chat:abc".to_string());
        assert_eq!(decode(&encode(&t)), Some(t));
        assert_eq!(decode("no-separator"), None);
    }
}
