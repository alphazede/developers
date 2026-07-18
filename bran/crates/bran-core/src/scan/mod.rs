mod digest;
mod ignore;

pub use digest::{ContentIdentity, IdentityComparison};
pub use ignore::{IgnoreDiagnostic, IgnoreMatcher, RuleError, MAX_OKFIGNORE_BYTES};

use crate::metadata::{MetadataParserRegistry, MetadataReport, PackageDefaults};
use std::collections::BTreeMap;
use std::fs::{self, DirEntry};
use std::path::{Path, PathBuf};

const DEFAULT_MAX_FILES: usize = 10_000;
const DEFAULT_MAX_FILE_BYTES: usize = 256 * 1024;
const DEFAULT_MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;
const MAX_SCAN_DEPTH: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScanConfig {
    pub max_files: usize,
    pub max_file_bytes: usize,
    pub max_total_bytes: usize,
    package_defaults: BTreeMap<String, PackageDefaults>,
}

impl Default for ScanConfig {
    fn default() -> Self {
        Self::new(
            DEFAULT_MAX_FILES,
            DEFAULT_MAX_FILE_BYTES,
            DEFAULT_MAX_TOTAL_BYTES,
        )
    }
}

impl ScanConfig {
    pub fn new(max_files: usize, max_file_bytes: usize, max_total_bytes: usize) -> Self {
        Self {
            max_files,
            max_file_bytes,
            max_total_bytes,
            package_defaults: BTreeMap::new(),
        }
    }

    pub fn set_package_defaults(
        &mut self,
        directory: impl AsRef<str>,
        defaults: PackageDefaults,
    ) -> Result<(), ScanFailure> {
        self.package_defaults
            .insert(safe_directory(directory.as_ref())?, defaults);
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScanEntry {
    pub identity: ContentIdentity,
    pub source: Vec<u8>,
    pub metadata: MetadataReport,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ScanDiagnostic {
    Symlink { path: String },
    Unreadable { path: String, reason: String },
    NonUtf8Path { path: String },
    UnsupportedInput { path: String },
    WeakIdentityMismatch { path: String },
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ScanSnapshot {
    pub entries: BTreeMap<String, ScanEntry>,
    pub diagnostics: Vec<ScanDiagnostic>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ScanChange {
    pub snapshot: ScanSnapshot,
    pub added: Vec<String>,
    pub changed: Vec<String>,
    pub removed: Vec<String>,
    pub reused: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScanFailure {
    InvalidRoot {
        path: PathBuf,
        reason: String,
    },
    InvalidPackageDirectory {
        directory: String,
    },
    InvalidIgnore(IgnoreDiagnostic),
    UnreadableIgnore {
        reason: String,
    },
    LimitExceeded {
        path: String,
        actual: usize,
        limit: usize,
    },
    DepthExceeded {
        path: String,
        actual: usize,
        limit: usize,
    },
    RootEscape {
        path: String,
    },
}

#[derive(Clone, Debug)]
pub struct RepositoryScanner {
    root: PathBuf,
    config: ScanConfig,
    parser: MetadataParserRegistry,
}

impl RepositoryScanner {
    pub fn new(root: impl AsRef<Path>, config: ScanConfig) -> Result<Self, ScanFailure> {
        let requested = root.as_ref().to_path_buf();
        let root = fs::canonicalize(&requested).map_err(|error| ScanFailure::InvalidRoot {
            path: requested.clone(),
            reason: error.to_string(),
        })?;
        if !root.is_dir() {
            return Err(ScanFailure::InvalidRoot {
                path: requested,
                reason: "not a directory".to_owned(),
            });
        }
        Ok(Self {
            parser: MetadataParserRegistry::new(config.max_file_bytes),
            root,
            config,
        })
    }

    pub fn scan(&self) -> Result<ScanSnapshot, ScanFailure> {
        self.collect(None)
    }

    pub fn scan_changed(&self, previous: &ScanSnapshot) -> Result<ScanChange, ScanFailure> {
        let mut snapshot = self.collect(Some(previous))?;
        let mut change = ScanChange::default();
        for (path, entry) in &snapshot.entries {
            match previous.entries.get(path) {
                Some(prior) if prior.identity == entry.identity && prior.source == entry.source => {
                    change.reused.push(path.clone());
                }
                Some(prior) => {
                    if prior.identity == entry.identity {
                        snapshot
                            .diagnostics
                            .push(ScanDiagnostic::WeakIdentityMismatch { path: path.clone() });
                    }
                    change.changed.push(path.clone());
                }
                None => change.added.push(path.clone()),
            }
        }
        for path in previous.entries.keys() {
            if !snapshot.entries.contains_key(path) {
                change.removed.push(path.clone());
            }
        }
        snapshot.diagnostics.sort();
        change.snapshot = snapshot;
        Ok(change)
    }

    fn collect(&self, previous: Option<&ScanSnapshot>) -> Result<ScanSnapshot, ScanFailure> {
        let matcher = self.read_ignore()?;
        let mut snapshot = ScanSnapshot::default();
        let mut limits = ScanLimits::default();
        self.walk(
            &self.root,
            "",
            0,
            &matcher,
            previous,
            &mut snapshot,
            &mut limits,
        )?;
        snapshot.diagnostics.sort();
        Ok(snapshot)
    }

    fn read_ignore(&self) -> Result<IgnoreMatcher, ScanFailure> {
        let path = self.root.join(".okfignore");
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(IgnoreMatcher::default());
            }
            Err(error) => return Err(unreadable_ignore(error)),
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(ScanFailure::UnreadableIgnore {
                reason: "root .okfignore must be a regular file, not a symlink".to_owned(),
            });
        }
        let advertised = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
        if advertised > MAX_OKFIGNORE_BYTES {
            return Err(ScanFailure::InvalidIgnore(
                IgnoreDiagnostic::InputTooLarge {
                    actual_bytes: advertised,
                },
            ));
        }
        let bytes = fs::read(path).map_err(unreadable_ignore)?;
        IgnoreMatcher::from_okfignore(&bytes).map_err(ScanFailure::InvalidIgnore)
    }

    #[allow(clippy::too_many_arguments)]
    fn walk(
        &self,
        directory: &Path,
        prefix: &str,
        depth: usize,
        matcher: &IgnoreMatcher,
        previous: Option<&ScanSnapshot>,
        snapshot: &mut ScanSnapshot,
        limits: &mut ScanLimits,
    ) -> Result<(), ScanFailure> {
        if depth > MAX_SCAN_DEPTH {
            return Err(ScanFailure::DepthExceeded {
                path: prefix.to_owned(),
                actual: depth,
                limit: MAX_SCAN_DEPTH,
            });
        }
        let current = match fs::symlink_metadata(directory) {
            Ok(metadata) => metadata,
            Err(error) => {
                unreadable(snapshot, prefix, error);
                return Ok(());
            }
        };
        if current.file_type().is_symlink() {
            snapshot.diagnostics.push(ScanDiagnostic::Symlink {
                path: prefix.to_owned(),
            });
            return Ok(());
        }
        let canonical = match fs::canonicalize(directory) {
            Ok(path) => path,
            Err(error) => {
                unreadable(snapshot, prefix, error);
                return Ok(());
            }
        };
        if !canonical.starts_with(&self.root) {
            return Err(ScanFailure::RootEscape {
                path: prefix.to_owned(),
            });
        }
        let entries = match fs::read_dir(canonical) {
            Ok(entries) => sorted_entries(entries, prefix, &mut snapshot.diagnostics),
            Err(error) => {
                unreadable(snapshot, prefix, error);
                return Ok(());
            }
        };
        for entry in entries {
            let name = match entry.file_name().into_string() {
                Ok(name) => name,
                Err(_) => {
                    snapshot.diagnostics.push(ScanDiagnostic::NonUtf8Path {
                        path: path_hint(prefix),
                    });
                    continue;
                }
            };
            let relative = join_relative(prefix, &name);
            if relative == ".okfignore" || matcher.is_ignored_relative(&relative) {
                continue;
            }
            limits.paths = limits.paths.saturating_add(1);
            let path_limit = self
                .config
                .max_files
                .saturating_mul(4)
                .saturating_add(MAX_SCAN_DEPTH);
            if limits.paths > path_limit {
                return Err(limit(&relative, limits.paths, path_limit));
            }
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) => {
                    unreadable(snapshot, &relative, error);
                    continue;
                }
            };
            if file_type.is_symlink() {
                snapshot
                    .diagnostics
                    .push(ScanDiagnostic::Symlink { path: relative });
            } else if file_type.is_dir() {
                self.walk(
                    &entry.path(),
                    &relative,
                    depth + 1,
                    matcher,
                    previous,
                    snapshot,
                    limits,
                )?;
            } else if file_type.is_file() {
                self.read_file(entry.path(), relative, previous, snapshot, limits)?;
            } else {
                snapshot
                    .diagnostics
                    .push(ScanDiagnostic::UnsupportedInput { path: relative });
            }
        }
        Ok(())
    }

    fn read_file(
        &self,
        path: PathBuf,
        relative: String,
        previous: Option<&ScanSnapshot>,
        snapshot: &mut ScanSnapshot,
        limits: &mut ScanLimits,
    ) -> Result<(), ScanFailure> {
        limits.files = limits.files.saturating_add(1);
        if limits.files > self.config.max_files {
            return Err(limit(&relative, limits.files, self.config.max_files));
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                unreadable(snapshot, &relative, error);
                return Ok(());
            }
        };
        if metadata.file_type().is_symlink() {
            snapshot
                .diagnostics
                .push(ScanDiagnostic::Symlink { path: relative });
            return Ok(());
        }
        let canonical = match fs::canonicalize(&path) {
            Ok(path) if path.starts_with(&self.root) => path,
            Ok(_) => return Err(ScanFailure::RootEscape { path: relative }),
            Err(error) => {
                unreadable(snapshot, &relative, error);
                return Ok(());
            }
        };
        let size = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
        self.check_bytes(&relative, size, limits.bytes)?;
        let source = match fs::read(&canonical) {
            Ok(source) => source,
            Err(error) => {
                unreadable(snapshot, &relative, error);
                return Ok(());
            }
        };
        self.check_bytes(&relative, source.len(), limits.bytes)?;
        if fs::symlink_metadata(&path).is_ok_and(|item| item.file_type().is_symlink()) {
            snapshot
                .diagnostics
                .push(ScanDiagnostic::Symlink { path: relative });
            return Ok(());
        }
        limits.bytes += source.len();
        let identity = ContentIdentity::from_bytes(&source);
        let reused = previous
            .and_then(|prior| prior.entries.get(&relative))
            .filter(|prior| {
                prior.identity == identity && prior.source.as_slice() == source.as_slice()
            });
        let metadata = if let Some(prior) = reused {
            prior.metadata.clone()
        } else {
            let text = match std::str::from_utf8(&source) {
                Ok(text) => text,
                Err(_) => {
                    snapshot
                        .diagnostics
                        .push(ScanDiagnostic::UnsupportedInput { path: relative });
                    return Ok(());
                }
            };
            self.parser
                .parse(&relative, text, &self.defaults_for(&relative))
        };
        snapshot.entries.insert(
            relative,
            ScanEntry {
                identity,
                source,
                metadata,
            },
        );
        Ok(())
    }

    fn check_bytes(&self, path: &str, size: usize, prior: usize) -> Result<(), ScanFailure> {
        if size > self.config.max_file_bytes {
            return Err(limit(path, size, self.config.max_file_bytes));
        }
        if size > self.config.max_total_bytes.saturating_sub(prior) {
            return Err(limit(
                path,
                prior.saturating_add(size),
                self.config.max_total_bytes,
            ));
        }
        Ok(())
    }

    fn defaults_for(&self, relative: &str) -> PackageDefaults {
        let parent = relative.rsplit_once('/').map_or("", |(parent, _)| parent);
        let mut applicable: Vec<_> = self
            .config
            .package_defaults
            .iter()
            .filter(|(directory, _)| {
                directory.is_empty()
                    || parent == directory.as_str()
                    || parent.starts_with(&format!("{directory}/"))
            })
            .collect();
        applicable.sort_by_key(|(directory, _)| directory.len());
        let mut defaults = PackageDefaults::default();
        for (_, package) in applicable {
            defaults.overlay(package);
        }
        defaults
    }
}

#[derive(Default)]
struct ScanLimits {
    paths: usize,
    files: usize,
    bytes: usize,
}

fn safe_directory(directory: &str) -> Result<String, ScanFailure> {
    if directory.is_empty() {
        return Ok(String::new());
    }
    if directory.starts_with('/')
        || directory.contains('\\')
        || directory
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return Err(ScanFailure::InvalidPackageDirectory {
            directory: directory.to_owned(),
        });
    }
    Ok(directory.to_owned())
}

fn sorted_entries(
    entries: fs::ReadDir,
    prefix: &str,
    diagnostics: &mut Vec<ScanDiagnostic>,
) -> Vec<DirEntry> {
    let mut values = Vec::new();
    for entry in entries {
        match entry {
            Ok(entry) => values.push(entry),
            Err(error) => diagnostics.push(ScanDiagnostic::Unreadable {
                path: prefix.to_owned(),
                reason: error.to_string(),
            }),
        }
    }
    values.sort_by_key(|entry| entry.file_name().to_string_lossy().into_owned());
    values
}

fn unreadable(snapshot: &mut ScanSnapshot, path: &str, error: std::io::Error) {
    snapshot.diagnostics.push(ScanDiagnostic::Unreadable {
        path: path.to_owned(),
        reason: error.to_string(),
    });
}

fn unreadable_ignore(error: std::io::Error) -> ScanFailure {
    ScanFailure::UnreadableIgnore {
        reason: error.to_string(),
    }
}

fn join_relative(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_owned()
    } else {
        format!("{prefix}/{name}")
    }
}

fn path_hint(prefix: &str) -> String {
    join_relative(prefix, "<non-utf8>")
}

fn limit(path: &str, actual: usize, limit: usize) -> ScanFailure {
    ScanFailure::LimitExceeded {
        path: path.to_owned(),
        actual,
        limit,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::{FactProvenance, PackageDefaults};
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    fn root() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "bran-scanner-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write(root: &Path, relative: &str, source: &[u8]) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, source).unwrap();
    }

    fn paths(snapshot: &ScanSnapshot) -> Vec<String> {
        snapshot.entries.keys().cloned().collect()
    }
    fn fact(report: &MetadataReport, key: &str, value: &str) -> bool {
        report.facts.iter().any(|item| {
            item.key == key
                && item.value == value
                && item.provenance == FactProvenance::PackageDefault
        })
    }
    fn boundary(report: &MetadataReport) -> bool {
        report
            .facts
            .iter()
            .any(|item| item.key == "important_boundary" && item.value == "true")
    }
    fn symlink(snapshot: &ScanSnapshot) -> bool {
        snapshot
            .diagnostics
            .iter()
            .any(|item| matches!(item, ScanDiagnostic::Symlink { path } if path == "outside.rs"))
    }
    fn file_limit(error: ScanFailure) -> bool {
        matches!(error, ScanFailure::LimitExceeded { limit: 2, .. })
    }

    #[cfg(unix)]
    fn outside_link(root: &Path) -> bool {
        let target = root.with_extension("outside");
        fs::write(&target, b"outside").unwrap();
        std::os::unix::fs::symlink(&target, root.join("outside.rs")).is_ok()
    }
    #[cfg(not(unix))]
    fn outside_link(_: &Path) -> bool {
        false
    }

    #[test]
    #[rustfmt::skip]
    fn p2_scanner() {
        let root = root();
        write(&root, ".okfignore", b"skip/\n");
        write(&root, "docs/readme.md", b"---\ntype: guide\n---\n# Readme\n");
        write(&root, "packages/core/infra/security.rs", b"pub fn locked() {}\n");
        write(&root, "src/a.rs", b"pub fn alpha() {}\n");
        write(&root, "src/z.rs", b"pub fn zulu() {}\n");
        write(&root, "node_modules/hidden.rs", b"pub fn hidden() {}\n");
        write(&root, "skip/ignored.rs", b"pub fn ignored() {}\n");
        let mut config = ScanConfig::new(16, 1024, 4096);
        config.set_package_defaults("", PackageDefaults::new([("owner".into(), "root".into())])).unwrap();
        config.set_package_defaults("packages", PackageDefaults::new([("owner".into(), "product".into())])).unwrap();
        config.set_package_defaults("packages/core", PackageDefaults::new([("kind".into(), "core".into())])).unwrap();
        let scanner = RepositoryScanner::new(&root, config.clone()).unwrap();
        let full = scanner.scan().unwrap();
        assert_eq!(paths(&full), vec!["docs/readme.md", "packages/core/infra/security.rs", "src/a.rs", "src/z.rs"]);
        assert!(!full.entries.contains_key("node_modules/hidden.rs"));
        assert!(!full.entries.contains_key("skip/ignored.rs"));
        assert!(fact(&full.entries["packages/core/infra/security.rs"].metadata, "kind", "core"));
        assert!(boundary(&full.entries["packages/core/infra/security.rs"].metadata));
        write(&root, "src/a.rs", b"pub fn altered() {}\n");
        let changed = scanner.scan_changed(&full).unwrap();
        assert_eq!(changed.changed, vec!["src/a.rs"]);
        assert_eq!(changed.reused, vec!["docs/readme.md", "packages/core/infra/security.rs", "src/z.rs"]);
        fs::remove_file(root.join("src/z.rs")).unwrap();
        let removed = scanner.scan_changed(&changed.snapshot).unwrap();
        assert_eq!(removed.removed, vec!["src/z.rs"]);
        assert_eq!(removed.snapshot.entries, scanner.scan().unwrap().entries);
        write(&root, "too-large.rs", &vec![b'x'; 1025]);
        assert!(matches!(scanner.scan(), Err(ScanFailure::LimitExceeded { path, .. }) if path == "too-large.rs"));
        fs::remove_file(root.join("too-large.rs")).unwrap();
        if outside_link(&root) {
            assert!(symlink(&scanner.scan().unwrap()));
            fs::remove_file(root.join("outside.rs")).unwrap();
        }
        let maxed = RepositoryScanner::new(&root, ScanConfig::new(2, 1024, 4096)).unwrap();
        assert!(file_limit(maxed.scan().unwrap_err()));
        fs::remove_dir_all(root).unwrap();
    }
}
