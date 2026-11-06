//! macOS notifications and the Dock badge, for chats that need you while the
//! window is in the background. A clicked notification comes back through
//! `clicks()` as (worktree id, tab key).

use std::sync::OnceLock;

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
#[allow(unexpected_cfgs, deprecated)] // the old objc/cocoa macros; NSUserNotification
mod mac {
    use super::{Target, channel, decode, encode};
    use cocoa::appkit::NSApp;
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::declare::ClassDecl;
    use objc::runtime::{BOOL, Class, Object, Sel, YES};
    use objc::{class, msg_send, sel, sel_impl};
    use std::sync::OnceLock;

    const KEY: &str = "forestRangerTarget";

    fn ns(s: &str) -> id {
        unsafe { NSString::alloc(nil).init_str(s) }
    }

    unsafe fn rust_str(s: id) -> Option<String> {
        if s == nil {
            return None;
        }
        let p: *const std::os::raw::c_char = unsafe { msg_send![s, UTF8String] };
        (!p.is_null()).then(|| unsafe { std::ffi::CStr::from_ptr(p) }.to_string_lossy().into_owned())
    }

    extern "C" fn did_activate(_: &Object, _: Sel, _center: id, note: id) {
        unsafe {
            let info: id = msg_send![note, userInfo];
            if info == nil {
                return;
            }
            let v: id = msg_send![info, objectForKey: ns(KEY)];
            if let Some(t) = rust_str(v).as_deref().and_then(decode) {
                let _ = channel().0.try_send(t);
            }
        }
    }

    /// Show it even if we happen to be frontmost by the time it lands.
    extern "C" fn should_present(_: &Object, _: Sel, _center: id, _note: id) -> BOOL {
        YES
    }

    /// The user-notification center with our delegate set, or nil (an unbundled
    /// binary may have none — then nothing is posted).
    fn center() -> id {
        static DELEGATE: OnceLock<usize> = OnceLock::new();
        unsafe {
            let center: id = msg_send![class!(NSUserNotificationCenter), defaultUserNotificationCenter];
            if center == nil {
                return nil;
            }
            DELEGATE.get_or_init(|| {
                let mut decl = ClassDecl::new("ForestRangerNotificationDelegate", class!(NSObject)).expect("delegate class");
                decl.add_method(
                    sel!(userNotificationCenter:didActivateNotification:),
                    did_activate as extern "C" fn(&Object, Sel, id, id),
                );
                decl.add_method(
                    sel!(userNotificationCenter:shouldPresentNotification:),
                    should_present as extern "C" fn(&Object, Sel, id, id) -> BOOL,
                );
                let cls: &Class = decl.register();
                // Never released: the center holds its delegate weakly.
                let delegate: id = msg_send![cls, new];
                let _: () = msg_send![center, setDelegate: delegate];
                delegate as usize
            });
            center
        }
    }

    pub fn post(title: &str, body: &str, target: Target) {
        let center = center();
        if center == nil {
            return;
        }
        unsafe {
            let n: id = msg_send![class!(NSUserNotification), new];
            let _: () = msg_send![n, setTitle: ns(title)];
            let _: () = msg_send![n, setInformativeText: ns(body)];
            let info: id = msg_send![class!(NSDictionary), dictionaryWithObject: ns(&encode(&target)) forKey: ns(KEY)];
            let _: () = msg_send![n, setUserInfo: info];
            let _: () = msg_send![center, deliverNotification: n];
        }
    }

    /// The Dock badge: the count, or none at 0.
    pub fn set_badge(count: usize) {
        unsafe {
            let tile: id = msg_send![NSApp(), dockTile];
            let label = if count == 0 { nil } else { ns(&count.to_string()) };
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
