pub const MEMBER_ACCESS_SECONDS: i64 = 15 * 60;
pub const MEMBER_SESSION_SECONDS: i64 = 24 * 60 * 60;
pub const MEMBER_REMEMBERED_SECONDS: i64 = 30 * 24 * 60 * 60;
pub const STAFF_ACCESS_SECONDS: i64 = 5 * 60;
pub const STAFF_ABSOLUTE_SECONDS: i64 = 8 * 60 * 60;
pub const STAFF_IDLE_SECONDS: i64 = 30 * 60;
pub const STAFF_WARNING_SECONDS: i64 = 25 * 60;
pub const ROTATION_RACE_GRACE_SECONDS: i64 = 5;
pub const MAX_CONSUMED_REFRESH_DIGESTS: usize = 4096;
pub const MAX_UNLOCK_REAUTH_ATTEMPTS: i32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionPolicy {
    pub access_expires_at: i64,
    pub absolute_expires_at: i64,
    pub idle_expires_at: Option<i64>,
    pub warning_at: Option<i64>,
}

impl SessionPolicy {
    pub fn for_role(role: &str, remember_me: bool, now: i64) -> Self {
        if matches!(role, "owner" | "admin" | "cs" | "staff") {
            Self {
                access_expires_at: now + STAFF_ACCESS_SECONDS,
                absolute_expires_at: now + STAFF_ABSOLUTE_SECONDS,
                idle_expires_at: Some(now + STAFF_IDLE_SECONDS),
                warning_at: Some(now + STAFF_WARNING_SECONDS),
            }
        } else {
            Self {
                access_expires_at: now + MEMBER_ACCESS_SECONDS,
                absolute_expires_at: now
                    + if remember_me {
                        MEMBER_REMEMBERED_SECONDS
                    } else {
                        MEMBER_SESSION_SECONDS
                    },
                idle_expires_at: None,
                warning_at: None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn member_policy_uses_exact_durations() {
        let standard = SessionPolicy::for_role("member", false, 1_000);
        assert_eq!(standard.access_expires_at, 1_000 + MEMBER_ACCESS_SECONDS);
        assert_eq!(standard.absolute_expires_at, 1_000 + MEMBER_SESSION_SECONDS);

        let remembered = SessionPolicy::for_role("member", true, 1_000);
        assert_eq!(
            remembered.absolute_expires_at,
            1_000 + MEMBER_REMEMBERED_SECONDS
        );
    }

    #[test]
    fn every_privileged_staff_role_ignores_remember_me_and_uses_staff_deadlines() {
        for role in ["owner", "admin", "cs", "staff"] {
            let policy = SessionPolicy::for_role(role, true, 1_000);
            assert_eq!(
                policy.access_expires_at,
                1_000 + STAFF_ACCESS_SECONDS,
                "{role}"
            );
            assert_eq!(
                policy.absolute_expires_at,
                1_000 + STAFF_ABSOLUTE_SECONDS,
                "{role}"
            );
            assert_eq!(
                policy.idle_expires_at,
                Some(1_000 + STAFF_IDLE_SECONDS),
                "{role}"
            );
            assert_eq!(
                policy.warning_at,
                Some(1_000 + STAFF_WARNING_SECONDS),
                "{role}"
            );
        }
    }
}
