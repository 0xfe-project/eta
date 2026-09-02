//! Progressive disclosure: skills catalog + mcp directory degradation.

use eta_core::Skill;
use eta_session::{
    McpServerDir, assemble_system_prompt, render_mcp_directory, render_skills_catalog,
};

fn skill(name: &str, desc: &str) -> Skill {
    Skill {
        name: name.into(),
        content: desc.into(),
    }
}

#[test]
fn full_catalog_fits_budget() {
    let skills = vec![skill("a", "short desc"), skill("b", "another desc")];
    let out = render_skills_catalog(&skills, &[], 1000);
    assert!(out.contains("a: short desc"));
    assert!(out.contains("b: another desc"));
}

#[test]
fn degrades_to_truncated_description() {
    let long = "x".repeat(1000);
    let skills = vec![skill("a", &long)];
    let out = render_skills_catalog(&skills, &[], 150);
    assert!(out.starts_with("- a: "));
    assert!(out.chars().count() < 600);
}

#[test]
fn degrades_to_omitted_notice() {
    let skills = vec![skill("a", "desc"), skill("b", "desc"), skill("c", "desc")];
    let out = render_skills_catalog(&skills, &[], 1);
    assert_eq!(out, "(3 skills omitted)");
}

#[test]
fn protected_names_survive_omission() {
    let skills = vec![
        skill("loop", "desc"),
        skill("a", "desc"),
        skill("b", "desc"),
    ];
    let out = render_skills_catalog(&skills, &["loop".into()], 1);
    assert_eq!(out, "loop");
}

#[test]
fn renders_mcp_directory() {
    let servers = vec![McpServerDir {
        name: "github".into(),
        description: "github api".into(),
        tools: vec!["search_repos".into(), "get_issue".into()],
    }];
    let out = render_mcp_directory(&servers);
    assert!(out.contains("<mcp_servers>"));
    assert!(out.contains("github"));
    assert!(out.contains("search_repos, get_issue"));
}

#[test]
fn assembles_stable_plus_adaptive() {
    let skills = vec![skill("a", "short desc")];
    let servers = vec![McpServerDir {
        name: "github".into(),
        description: "github api".into(),
        tools: vec!["search_repos".into()],
    }];
    let out = assemble_system_prompt("persona + memory", &skills, &[], &servers, 1000);
    assert!(out.starts_with("persona + memory"));
    assert!(out.contains("a: short desc"));
    assert!(out.contains("<mcp_servers>"));
}
