//! Progressive disclosure: skills catalog degradation.

use eta_core::Skill;
use eta_session::render_skills_catalog;

fn skill(name: &str, desc: &str) -> Skill {
    Skill {
        name: name.into(),
        description: desc.into(),
    }
}

#[test]
fn full_catalog_fits_budget() {
    let skills = vec![skill("a", "short desc"), skill("b", "another desc")];
    let out = render_skills_catalog(&skills, 1000);
    assert!(out.contains("a: short desc"));
    assert!(out.contains("b: another desc"));
}

#[test]
fn degrades_to_truncated_description() {
    let long = "x".repeat(1000);
    let skills = vec![skill("a", &long)];
    let out = render_skills_catalog(&skills, 150);
    assert!(out.starts_with("- a: "));
    assert!(out.chars().count() < 600);
}

#[test]
fn degrades_to_omitted_notice() {
    let skills = vec![skill("a", "desc"), skill("b", "desc"), skill("c", "desc")];
    let out = render_skills_catalog(&skills, 1);
    assert_eq!(out, "(3 skills omitted)");
}
