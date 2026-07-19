use crate::domain::{NativeImage, TerminalCapabilities};

pub const RAVEN_WIDE: &str = include_str!("../../../assets/tui/raven-wide.txt");
pub const RAVEN_NARROW: &str = include_str!("../../../assets/tui/raven-narrow.txt");
pub const RAVEN_PLAIN: &str = include_str!("../../../assets/tui/raven-plain.txt");

pub fn render_surface(
    capabilities: TerminalCapabilities,
    _motion: bool,
    _native_image: NativeImage,
) -> String {
    let raven = if !capabilities.unicode {
        RAVEN_PLAIN
    } else if capabilities.columns >= 80 {
        RAVEN_WIDE
    } else {
        RAVEN_NARROW
    };
    if capabilities.no_color {
        format!("{raven}\nBRAN\nALPHAZEDE.com\n")
    } else {
        format!("{raven}\n\x1b[1mBRAN\x1b[0m\n\x1b[2mALPHAZEDE.com\x1b[0m\n")
    }
}
