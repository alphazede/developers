use std::process::ExitCode;

const SMOKE_OUTPUT: &str = "{\"version\":\"1\",\"status\":\"ok\"}";
const MISSING_COMMAND_ERROR: &str = "{\"version\":\"1\",\"error\":\"missing_command\"}";
const UNKNOWN_COMMAND_ERROR: &str = "{\"version\":\"1\",\"error\":\"unknown_command\"}";

fn main() -> ExitCode {
    CliApp::run(std::env::args().skip(1)).write_to_stdio()
}

struct CliApp;

impl CliApp {
    fn run(arguments: impl IntoIterator<Item = String>) -> CliResult {
        let mut arguments = arguments.into_iter();
        match (arguments.next(), arguments.next()) {
            (Some(command), None) if command == "smoke" => CliResult::success(SMOKE_OUTPUT),
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

    fn run(arguments: &[&str]) -> super::CliResult {
        CliApp::run(arguments.iter().map(|argument| (*argument).to_owned()))
    }

    #[test]
    fn smoke_has_exact_deterministic_output() {
        let result = run(&["smoke"]);

        assert_eq!(result.output, SMOKE_OUTPUT);
        assert_eq!(result.exit_code, ExitCode::SUCCESS);
        assert!(!result.is_error);
        assert_eq!(result.output, "{\"version\":\"1\",\"status\":\"ok\"}");
    }

    #[test]
    fn missing_command_has_a_stable_versioned_error() {
        let result = run(&[]);

        assert_eq!(result.output, MISSING_COMMAND_ERROR);
        assert_eq!(result.exit_code, ExitCode::FAILURE);
        assert!(result.is_error);
        assert_eq!(
            result.output,
            "{\"version\":\"1\",\"error\":\"missing_command\"}"
        );
    }

    #[test]
    fn unknown_commands_have_a_stable_versioned_error() {
        for arguments in [["other"].as_slice(), ["smoke", "extra"].as_slice()] {
            let result = run(arguments);

            assert_eq!(result.output, UNKNOWN_COMMAND_ERROR);
            assert_eq!(result.exit_code, ExitCode::FAILURE);
            assert!(result.is_error);
            assert_eq!(
                result.output,
                "{\"version\":\"1\",\"error\":\"unknown_command\"}"
            );
        }
    }
}
