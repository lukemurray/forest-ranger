// Link libghostty-vt (static, from the prebuilt XCFramework; fetched on first build).
fn main() {
    let dir = std::path::Path::new("vendor/ghostty-vt.xcframework/macos-arm64_x86_64");
    if !dir.join("libghostty-vt.a").exists() {
        let ok = std::process::Command::new("scripts/fetch-libghostty.sh").status().is_ok_and(|s| s.success());
        assert!(ok, "couldn't fetch libghostty-vt: run scripts/fetch-libghostty.sh");
    }
    println!("cargo:rustc-link-search=native={}", std::fs::canonicalize(dir).unwrap().display());
    println!("cargo:rustc-link-lib=static=ghostty-vt");
    println!("cargo:rerun-if-changed=build.rs");
}
