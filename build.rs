// Link libghostty-vt (static, from the prebuilt XCFramework; fetched on first build).
fn main() {
    let dir = std::path::Path::new("vendor/ghostty-vt.xcframework/macos-arm64_x86_64");
    // The version is pinned in the fetch script: a bump there means fetching again.
    let stamp = std::path::Path::new("vendor/ghostty-vt.version");
    let want = std::fs::read_to_string("scripts/fetch-libghostty.sh").ok().and_then(|s| s.lines().find_map(|l| l.strip_prefix("VERSION=").map(str::to_string)));
    let have = std::fs::read_to_string(stamp).ok().map(|s| s.trim().to_string());
    if !dir.join("libghostty-vt.a").exists() || want != have {
        let ok = std::process::Command::new("scripts/fetch-libghostty.sh").status().is_ok_and(|s| s.success());
        assert!(ok, "couldn't fetch libghostty-vt: run scripts/fetch-libghostty.sh");
    }
    println!("cargo:rustc-link-search=native={}", std::fs::canonicalize(dir).unwrap().display());
    println!("cargo:rustc-link-lib=static=ghostty-vt");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=scripts/fetch-libghostty.sh");
}
