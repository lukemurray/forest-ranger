//! Low-rate looping animations. GPUI's `.repeat()` animations ask for a frame on
//! every display refresh (120 Hz here), and each frame re-renders the animated
//! view and every view above it — the whole window, for a pulsing 8px dot. These
//! instead compute the value from the clock at render time, and a `Ticker` redraws
//! the view 10 times a second, only while something is animating.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use gpui_kit::*;

const FRAME: Duration = Duration::from_millis(100);

/// Where a `period_ms` loop is now, 0..1. One shared clock, so loops stay in step.
pub fn phase(period_ms: u64) -> f32 {
    static START: OnceLock<Instant> = OnceLock::new();
    let ms = START.get_or_init(Instant::now).elapsed().as_millis() as u64;
    (ms % period_ms) as f32 / period_ms as f32
}

/// GPUI's `pulsating_between` breathing curve, at the current point of the loop.
pub fn pulse(period_ms: u64, min: f32, max: f32) -> f32 {
    pulsating_between(min, max)(phase(period_ms))
}

/// Redraws its view every `FRAME` while kept on.
#[derive(Default)]
pub struct Ticker(Option<Task<()>>);

impl Ticker {
    /// Call from `render` with whether anything animating is shown.
    pub fn keep<T: 'static>(&mut self, on: bool, cx: &mut Context<T>) {
        if !on {
            self.0 = None;
        } else if self.0.is_none() {
            self.0 = Some(cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(FRAME).await;
                    if this.update(cx, |_, cx| cx.notify()).is_err() {
                        break;
                    }
                }
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn phase_and_pulse_stay_in_range() {
        let p = super::phase(1400);
        assert!((0.0..1.0).contains(&p));
        let a = super::pulse(1400, 0.45, 1.);
        assert!((0.45..=1.0).contains(&a), "{a}");
    }
}
