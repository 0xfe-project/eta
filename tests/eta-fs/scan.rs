use eta_fs::ResourceScanner;
use std::fs;

#[test]
fn scans_project_skills_and_applies_later_override() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("repo");
    fs::create_dir_all(project.join(".git")).unwrap();
    fs::create_dir_all(project.join(".agents/skills/demo")).unwrap();
    fs::write(project.join(".agents/skills/demo/SKILL.md"), "project").unwrap();
    let nested = project.join("src");
    fs::create_dir_all(&nested).unwrap();

    let scanner = ResourceScanner::new(&nested);
    let skills = scanner.skills();
    assert_eq!(
        fs::read_to_string(skills.get("demo").unwrap()).unwrap(),
        "project"
    );
    assert!(
        scanner
            .skill_roots()
            .iter()
            .any(|p| p.ends_with(".agents/skills"))
    );
    assert!(scanner.watch_paths().iter().any(|p| p.ends_with(".eta")));
}

#[test]
fn discovers_submodule_skill_roots() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("repo");
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::create_dir_all(root.join("vendor/lib/.agents/skills/tool")).unwrap();
    fs::write(
        root.join("vendor/lib/.agents/skills/tool/SKILL.md"),
        "submodule",
    )
    .unwrap();
    fs::write(
        root.join(".gitmodules"),
        "[submodule \"lib\"]\n\tpath = vendor/lib\n",
    )
    .unwrap();
    let scanner = ResourceScanner::new(&root);
    assert!(
        scanner
            .skill_roots()
            .iter()
            .any(|p| p.ends_with("vendor/lib/.agents/skills"))
    );
}
