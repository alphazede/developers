use std::ffi::OsStr;
use std::process::ExitCode;

const SMOKE_OUTPUT: &str = "{\"version\":\"1\",\"status\":\"ok\"}";
const MISSING_COMMAND_ERROR: &str = "{\"version\":\"1\",\"error\":\"missing_command\"}";
const UNKNOWN_COMMAND_ERROR: &str = "{\"version\":\"1\",\"error\":\"unknown_command\"}";

fn main() -> ExitCode {
    CliApp::run(std::env::args_os().skip(1)).write_to_stdio()
}

struct CliApp;

impl CliApp {
    fn run<I>(arguments: I) -> CliResult
    where
        I: IntoIterator,
        I::Item: AsRef<OsStr>,
    {
        let mut arguments = arguments.into_iter();
        match (arguments.next(), arguments.next()) {
            (Some(command), None) if command.as_ref() == OsStr::new("smoke") => {
                CliResult::success(SMOKE_OUTPUT)
            }
            (None, _) => CliResult::error(MISSING_COMMAND_ERROR),
            _ => CliResult::error(UNKNOWN_COMMAND_ERROR),
        }
    }
}

struct CliResult {
    output: &'static str,
    exit_code: ExitCode,
    is_error: bool,
}

impl CliResult {
    const fn success(output: &'static str) -> Self {
        Self {
            output,
            exit_code: ExitCode::SUCCESS,
            is_error: false,
        }
    }

    const fn error(output: &'static str) -> Self {
        Self {
            output,
            exit_code: ExitCode::FAILURE,
            is_error: true,
        }
    }

    fn write_to_stdio(self) -> ExitCode {
        if self.is_error {
            eprintln!("{}", self.output);
        } else {
            println!("{}", self.output);
        }
        self.exit_code
    }
}

#[cfg(test)]
mod tests {
    use super::{CliApp, ExitCode, MISSING_COMMAND_ERROR, SMOKE_OUTPUT, UNKNOWN_COMMAND_ERROR};

    #[test]
    fn p1_cli() {
        let smoke = CliApp::run(["smoke".to_owned()]);
        assert_eq!(smoke.output, SMOKE_OUTPUT);
        assert_eq!(smoke.exit_code, ExitCode::SUCCESS);
        assert!(!smoke.is_error);

        let missing = CliApp::run(Vec::<String>::new());
        assert_eq!(missing.output, MISSING_COMMAND_ERROR);
        assert_eq!(missing.exit_code, ExitCode::FAILURE);
        assert!(missing.is_error);

        let unknown = CliApp::run(["other".to_owned()]);
        assert_eq!(unknown.output, UNKNOWN_COMMAND_ERROR);
        assert_eq!(unknown.exit_code, ExitCode::FAILURE);
        assert!(unknown.is_error);

        let extra = CliApp::run(["smoke".to_owned(), "extra".to_owned()]);
        assert_eq!(extra.output, UNKNOWN_COMMAND_ERROR);
        assert_eq!(extra.exit_code, ExitCode::FAILURE);
        assert!(extra.is_error);

        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            let non_utf8 = CliApp::run([std::ffi::OsString::from_vec(vec![0xff])]);
            assert_eq!(non_utf8.output, UNKNOWN_COMMAND_ERROR);
            assert_eq!(non_utf8.exit_code, ExitCode::FAILURE);
            assert!(non_utf8.is_error);
        }
    }
}
