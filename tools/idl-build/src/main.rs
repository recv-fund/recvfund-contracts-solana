use anchor_lang_idl::build::IdlBuilder;
use std::{env, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    // Run the official locked Anchor IDL compiler directly. The 0.31.1 CLI
    // embeds an older builder that forces procmacro2_semver_exempt, breaking
    // account-seed parsing. Never parse source or hand-maintain the ABI.
    // Cargo already selected the host toolchain before starting this process.
    // Removing this variable avoids IdlBuilder 0.1.4's literal +{toolchain}
    // argument; rustup's selected toolchain remains available on PATH.
    env::remove_var("RUSTUP_TOOLCHAIN");
    let idl = IdlBuilder::new()
        .program_path(root.join("programs/recvfund"))
        .resolution(true)
        .skip_lint(false)
        .cargo_args(vec!["--locked".into()])
        .build()?;
    let destination = root.join("target/idl/recvfund.json");
    fs::create_dir_all(destination.parent().unwrap())?;
    fs::write(&destination, serde_json::to_string_pretty(&idl)? + "\n")?;
    println!("Generated and validated {}", destination.display());
    Ok(())
}
