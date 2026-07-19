/// Explicit terminal facts used to choose a character-art surface.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalCapabilities {
    pub columns: u16,
    pub unicode: bool,
    pub no_color: bool,
}

impl TerminalCapabilities {
    pub const fn wide() -> Self {
        Self {
            columns: 80,
            unicode: true,
            no_color: false,
        }
    }

    pub const fn narrow() -> Self {
        Self {
            columns: 40,
            unicode: true,
            no_color: false,
        }
    }

    pub const fn plain() -> Self {
        Self {
            columns: 80,
            unicode: false,
            no_color: false,
        }
    }

    pub const fn no_color(mut self) -> Self {
        self.no_color = true;
        self
    }
}

/// Native image paths are deliberately not used by this core surface.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeImage {
    Unavailable,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TuiEvent {
    Input(char),
    Backspace,
    CtrlS,
}

/// Small, deterministic input and event state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TuiApp {
    pub input: String,
    pub status: String,
    pub motion: bool,
    pub native_image: NativeImage,
}

impl Default for TuiApp {
    fn default() -> Self {
        Self {
            input: String::new(),
            status: String::new(),
            motion: true,
            native_image: NativeImage::Unavailable,
        }
    }
}

impl TuiApp {
    pub fn handle(&mut self, event: TuiEvent) {
        match event {
            TuiEvent::Input(character) => self.input.push(character),
            TuiEvent::Backspace => {
                self.input.pop();
            }
            TuiEvent::CtrlS => self.status = "Voice shortcut unavailable".to_owned(),
        }
    }
}

pub const AUTOCOMPLETE_SCAN_BUDGET: usize = 8;
pub const AUTOCOMPLETE_RESULT_BUDGET: usize = 3;

/// Returns prefix matches from at most the first eight newline-separated candidates.
pub fn autocomplete(query: &str, candidates: &str) -> Vec<String> {
    let query = query.to_ascii_lowercase();
    let mut results = Vec::new();
    for candidate in candidates.lines().take(AUTOCOMPLETE_SCAN_BUDGET) {
        if candidate.to_ascii_lowercase().starts_with(&query) {
            results.push(candidate.to_owned());
            if results.len() == AUTOCOMPLETE_RESULT_BUDGET {
                break;
            }
        }
    }
    results
}
