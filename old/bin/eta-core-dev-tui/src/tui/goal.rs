//! Goal status-line rendering (E9).

/// The subset of goal state the status line needs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GoalInfo {
    pub status: String,
    pub objective: String,
    pub round: u64,
}

impl GoalInfo {
    /// `goal: <status> <objective> · round <n>`, or `goal: —` when no goal.
    pub fn status_line(&self) -> String {
        if self.objective.is_empty() {
            "goal: —".to_string()
        } else {
            format!(
                "goal: {} {} · round {}",
                self.status, self.objective, self.round
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::GoalInfo;

    #[test]
    fn formats_active_goal() {
        let goal = GoalInfo {
            status: "active".into(),
            objective: "ship it".into(),
            round: 3,
        };
        assert_eq!(goal.status_line(), "goal: active ship it · round 3");
    }

    #[test]
    fn empty_objective_renders_dash() {
        assert_eq!(GoalInfo::default().status_line(), "goal: —");
    }
}
