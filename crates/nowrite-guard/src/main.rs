use landlock::{
    AccessFs, BitFlags, CompatLevel, Compatible, PathBeneath, PathFd, Ruleset,
    RulesetAttr, RulesetCreatedAttr, RulesetStatus, ABI,
};
use std::env;
use std::ffi::OsString;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

fn get_write_access(abi: ABI) -> BitFlags<AccessFs> {
    let mut flags = AccessFs::WriteFile
        | AccessFs::RemoveDir
        | AccessFs::RemoveFile
        | AccessFs::MakeChar
        | AccessFs::MakeDir
        | AccessFs::MakeReg
        | AccessFs::MakeSock
        | AccessFs::MakeFifo
        | AccessFs::MakeBlock
        | AccessFs::MakeSym;

    if abi >= ABI::V2 {
        flags |= AccessFs::Refer;
    }
    if abi >= ABI::V3 {
        flags |= AccessFs::Truncate;
    }
    if abi >= ABI::V5 {
        flags |= AccessFs::IoctlDev;
    }

    flags
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<OsString> = env::args_os().collect();

    if args.len() >= 2 && args[1] == "--version" {
        let ruleset = Ruleset::default()
            .set_compatibility(CompatLevel::BestEffort)
            .handle_access(get_write_access(ABI::V5))?;

        match ruleset.create()?.set_compatibility(CompatLevel::BestEffort).restrict_self() {
            Ok(status) => match status.landlock {
                landlock::LandlockStatus::Available {
                    effective_abi,
                    kernel_abi,
                } => {
                    let ver = kernel_abi
                        .map(|k| k.to_string())
                        .unwrap_or_else(|| format!("{:?}", effective_abi).trim_start_matches('V').to_string());
                    println!("nowrite-guard landlock ABI {}", ver);
                    return Ok(());
                }
                _ => {
                    eprintln!("nowrite-guard: Landlock not available on this kernel");
                    std::process::exit(1);
                }
            },
            Err(e) => {
                eprintln!("nowrite-guard: Landlock not supported ({})", e);
                std::process::exit(1);
            }
        }
    }

    let abi = ABI::V5;
    let write_access = get_write_access(abi);

    let ruleset = Ruleset::default()
        .set_compatibility(CompatLevel::BestEffort)
        .handle_access(write_access)?;

    let mut chdir_path: Option<PathBuf> = None;
    let mut cmd_start_idx = None;
    let mut rw_paths: Vec<PathBuf> = Vec::new();

    let mut i = 1;
    while i < args.len() {
        if args[i] == "--" {
            cmd_start_idx = Some(i + 1);
            break;
        }
        if args[i] == "--rw" && i + 1 < args.len() {
            i += 1;
            rw_paths.push(PathBuf::from(&args[i]));
            i += 1;
            continue;
        }
        if args[i] == "--chdir" && i + 1 < args.len() {
            i += 1;
            chdir_path = Some(PathBuf::from(&args[i]));
            i += 1;
            continue;
        }
        i += 1;
    }

    let cmd_start = match cmd_start_idx {
        Some(idx) if idx < args.len() => idx,
        _ => {
            eprintln!("Usage: nowrite-guard [--rw <path> ...] [--chdir <dir>] -- <command> [args...]");
            std::process::exit(2);
        }
    };

    let rules = rw_paths
        .into_iter()
        .filter_map(|path| {
            if path.exists() {
                PathFd::new(&path).ok().map(|fd| Ok::<_, landlock::RulesetError>(PathBeneath::new(fd, write_access)))
            } else {
                None
            }
        });

    let created = ruleset.create()?.add_rules(rules)?;

    if let Some(ref cd_path) = chdir_path {
        env::set_current_dir(cd_path)?;
    }

    let status = created
        .set_compatibility(CompatLevel::BestEffort)
        .restrict_self()?;

    if status.ruleset == RulesetStatus::NotEnforced {
        eprintln!("nowrite-guard: Landlock ruleset could not be enforced");
        std::process::exit(1);
    }

    let cmd_name = &args[cmd_start];
    let cmd_args = &args[cmd_start + 1..];

    let err = Command::new(cmd_name).args(cmd_args).exec();
    eprintln!("nowrite-guard: exec failed: {}", err);
    std::process::exit(127);
}
