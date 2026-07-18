use bran_core::scan::{RepositoryScanner, ScanConfig};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

const FILE_COUNT: usize = 128;
const FILE_BYTES: usize = 1024;
static NEXT_ROOT: AtomicUsize = AtomicUsize::new(0);

fn benchmark_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "bran-repository-scan-bench-{}-{}",
        std::process::id(),
        NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
    ))
}

fn make_corpus(root: &Path) {
    fs::create_dir_all(root.join("src")).expect("create benchmark corpus");
    let source = vec![b'x'; FILE_BYTES];
    for index in 0..FILE_COUNT {
        fs::write(root.join(format!("src/module-{index:03}.rs")), &source)
            .expect("write benchmark source");
    }
}

fn elapsed(operation: impl FnOnce()) -> Duration {
    let started = Instant::now();
    operation();
    started.elapsed()
}

fn main() {
    let root = benchmark_root();
    make_corpus(&root);
    let scanner = RepositoryScanner::new(
        &root,
        ScanConfig::new(FILE_COUNT, FILE_BYTES, FILE_COUNT * FILE_BYTES),
    )
    .expect("construct bounded scanner");

    let mut snapshot = None;
    let full = elapsed(|| snapshot = Some(scanner.scan().expect("full scan")));
    let snapshot = snapshot.expect("full snapshot");
    assert_eq!(snapshot.entries.len(), FILE_COUNT);

    let mut change = None;
    let incremental = elapsed(|| {
        change = Some(scanner.scan_changed(&snapshot).expect("incremental scan"));
    });
    let change = change.expect("incremental result");
    assert_eq!(change.snapshot.entries, snapshot.entries);
    assert_eq!(change.reused.len(), FILE_COUNT);
    assert!(change.added.is_empty() && change.changed.is_empty() && change.removed.is_empty());

    fs::remove_dir_all(&root).expect("remove benchmark corpus");
    println!(
        "repository_scan files={FILE_COUNT} bytes={} full_ns={} incremental_ns={}",
        FILE_COUNT * FILE_BYTES,
        full.as_nanos(),
        incremental.as_nanos()
    );
}
