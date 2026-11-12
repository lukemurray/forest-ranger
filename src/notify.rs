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
pub use mac::{init, open_settings, post, refresh_status, set_badge, status};

#[cfg(not(target_os = "macos"))]
pub fn init() {}
#[cfg(not(target_os = "macos"))]
pub fn status() -> isize {
    -1
}
#[cfg(not(target_os = "macos"))]
pub fn refresh_status() {}
#[cfg(not(target_os = "macos"))]
pub fn open_settings() {}
#[cfg(not(target_os = "macos"))]
pub fn post(_title: &str, _body: &str, _target: Target) {}
#[cfg(not(target_os = "macos"))]
pub fn set_badge(_count: usize) {}

/// UNUserNotificationCenter (the deprecated NSUserNotificationCenter delivers
/// nothing on current macOS). It needs a bundled app — a bare `cargo run` binary
/// has no bundle id and calling it would crash — so there it's a no-op.
#[cfg(target_os = "macos")]
mod mac {
    use super::{Target, channel, decode, encode};
    use block2::{Block, RcBlock};
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, NSObject, Sel};
    use objc2::{ClassType, class, msg_send, sel};
    use objc2_foundation::NSString;
    use std::ffi::{CStr, c_char};
    use std::sync::OnceLock;

    #[link(name = "UserNotifications", kind = "framework")]
    unsafe extern "C" {}

    const KEY: &str = "forestRangerTarget";
    /// UNNotificationPresentationOptions: sound | list | banner — show it even when
    /// we're frontmost by the time it lands.
    const PRESENT: usize = (1 << 1) | (1 << 3) | (1 << 4);
    /// UNAuthorizationOptions: badge | sound | alert.
    const AUTH: usize = 1 | 2 | 4;

    unsafe fn rust_str(s: *mut AnyObject) -> Option<String> {
        if s.is_null() {
            return None;
        }
        let p: *const c_char = unsafe { msg_send![s, UTF8String] };
        (!p.is_null()).then(|| unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned())
    }

    fn bundled() -> bool {
        unsafe {
            let bundle: *mut AnyObject = msg_send![class!(NSBundle), mainBundle];
            let id: *mut AnyObject = msg_send![bundle, bundleIdentifier];
            !id.is_null()
        }
    }

    /// A click: route it back through `clicks()`.
    extern "C-unwind" fn did_receive(_: *mut AnyObject, _: Sel, _center: *mut AnyObject, response: *mut AnyObject, done: *mut Block<dyn Fn()>) {
        unsafe {
            let note: *mut AnyObject = msg_send![response, notification];
            let request: *mut AnyObject = msg_send![note, request];
            let content: *mut AnyObject = msg_send![request, content];
            let info: *mut AnyObject = msg_send![content, userInfo];
            if !info.is_null() {
                let v: *mut AnyObject = msg_send![info, objectForKey: &*NSString::from_str(KEY)];
                if let Some(t) = rust_str(v).as_deref().and_then(decode) {
                    let _ = channel().0.try_send(t);
                }
            }
        }
        if let Some(done) = unsafe { done.as_ref() } {
            done.call(());
        }
    }

    extern "C-unwind" fn will_present(_: *mut AnyObject, _: Sel, _center: *mut AnyObject, _note: *mut AnyObject, done: *mut Block<dyn Fn(usize)>) {
        if let Some(done) = unsafe { done.as_ref() } {
            done.call((PRESENT,));
        }
    }

    /// The notification center with our delegate set; None when not bundled.
    fn center() -> Option<*mut AnyObject> {
        static DELEGATE: OnceLock<usize> = OnceLock::new();
        if !bundled() {
            return None;
        }
        unsafe {
            let center: *mut AnyObject = msg_send![class!(UNUserNotificationCenter), currentNotificationCenter];
            if center.is_null() {
                return None;
            }
            DELEGATE.get_or_init(|| {
                let mut b = ClassBuilder::new(c"ForestRangerUNDelegate", NSObject::class()).expect("delegate class");
                b.add_method(
                    sel!(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:),
                    did_receive as extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject, *mut Block<dyn Fn()>),
                );
                b.add_method(
                    sel!(userNotificationCenter:willPresentNotification:withCompletionHandler:),
                    will_present as extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject, *mut Block<dyn Fn(usize)>),
                );
                let cls: &AnyClass = b.register();
                // Never released: the center holds its delegate weakly.
                let delegate: *mut AnyObject = msg_send![cls, new];
                let _: () = msg_send![center, setDelegate: delegate];
                delegate as usize
            });
            Some(center)
        }
    }

    /// At launch: set the delegate (so a click that launched us is caught) and ask
    /// for permission — macOS asks the user once, then remembers.
    pub fn init() {
        let Some(center) = center() else { return };
        let done = RcBlock::new(|_granted: Bool, _err: *mut AnyObject| refresh_status());
        unsafe {
            let _: () = msg_send![center, requestAuthorizationWithOptions: AUTH, completionHandler: &*done];
        }
    }

    pub fn post(title: &str, body: &str, target: Target) {
        let Some(center) = center() else { return };
        unsafe {
            let content: *mut AnyObject = msg_send![class!(UNMutableNotificationContent), new];
            let _: () = msg_send![content, setTitle: &*NSString::from_str(title)];
            let _: () = msg_send![content, setBody: &*NSString::from_str(body)];
            let sound: *mut AnyObject = msg_send![class!(UNNotificationSound), defaultSound];
            let _: () = msg_send![content, setSound: sound];
            let info: *mut AnyObject = msg_send![
                class!(NSDictionary),
                dictionaryWithObject: &*NSString::from_str(&encode(&target)),
                forKey: &*NSString::from_str(KEY)
            ];
            let _: () = msg_send![content, setUserInfo: info];
            let id = NSString::from_str(&uuid::Uuid::new_v4().to_string());
            let request: *mut AnyObject =
                msg_send![class!(UNNotificationRequest), requestWithIdentifier: &*id, content: content, trigger: std::ptr::null_mut::<AnyObject>()];
            let done: Option<&Block<dyn Fn(*mut AnyObject)>> = None;
            let _: () = msg_send![center, addNotificationRequest: request, withCompletionHandler: done];
            let _: () = msg_send![content, release];
        }
    }

    /// macOS's answer for us, refreshed by `refresh_status`: -1 unknown (or not a
    /// bundled app), 0 not asked yet, 1 denied, 2 allowed, 3 provisional, 4 ephemeral.
    static STATUS: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(-1);

    pub fn status() -> isize {
        STATUS.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Ask macOS (async) whether we may notify; `status()` has the answer shortly after.
    pub fn refresh_status() {
        let Some(center) = center() else { return };
        let done = RcBlock::new(|settings: *mut AnyObject| {
            let status: isize = unsafe { msg_send![settings, authorizationStatus] };
            STATUS.store(status, std::sync::atomic::Ordering::Relaxed);
        });
        unsafe {
            let _: () = msg_send![center, getNotificationSettingsWithCompletionHandler: &*done];
        }
    }

    /// System Settings → Notifications → Forest Ranger.
    pub fn open_settings() {
        let _ = std::process::Command::new("open").arg("x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=dev.forestranger.app").spawn();
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
